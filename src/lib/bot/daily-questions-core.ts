import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getNextActiveDayForClient } from '@/lib/db/queries/bot'
import { getDailyQuestionText } from '@/lib/bot/templates'
import { getEarliestSameDayCutoff, formatCutoff } from '@/lib/utils/cutoff'
import { sendBotMessage } from '@/lib/max/send-message'
import { getActiveMaxChatIdForClient } from '@/lib/bot/max-users'

/**
 * Общее ядро для cron'ов daily-questions и daily-questions-sameday.
 *
 * Оба cron'а делают одно и то же: находят активных DYNAMIC-клиентов, выбирают
 * целевую дату доставки, создают PENDING-conversation и шлют клиенту вопрос.
 * Различаются только в (а) фильтре клиентов (sameDay vs обычные) и (б) логике
 * выбора целевой даты (завтра-и-далее vs строго сегодня). Эти два различия
 * вынесены в параметры; всё остальное переиспользуется.
 */

export interface ErrorEntry {
  clientName: string
  reason: string
}

export interface RunResult {
  total_candidates: number
  sent: number
  skipped_not_onboarded: number
  skipped_existing: number
  skipped_no_active_day: number
  errors: ErrorEntry[]
}

/**
 * Чистая функция-builder фильтра клиентов для запроса кандидатов.
 *
 * sameDayOnly === true  → клиенты, у которых ЕСТЬ хотя бы одна sameDay-локация
 *                         (берёт cron daily-questions-sameday).
 * sameDayOnly === false → клиенты БЕЗ единой sameDay-локации
 *                         (берёт обычный cron daily-questions; sameDay-клиенты
 *                          исключены, чтобы не словить двойную рассылку).
 *
 * Вынесено отдельно и без побочных эффектов — для прямого юнит-тестирования
 * семантики some/none.
 */
export function buildCandidatesWhere(sameDayOnly: boolean): Prisma.ClientWhereInput {
  return {
    isActive: true,
    mealConfigs: { some: { orderType: 'DYNAMIC', isActive: true } },
    locations: sameDayOnly
      ? { some: { sameDayDelivery: true } }
      : { none: { sameDayDelivery: true } },
  }
}

export type TargetDateMode = 'next-active' | 'today-only'

export interface RunDailyQuestionsOptions {
  /** Лейбл для логов: 'daily-questions' | 'daily-questions-sameday'. */
  label: string
  /** UTC-полночь МСК-сегодня (getMskCalendarDayUtc(now, 0)). */
  todayMsk: Date
  /**
   * Какую дату доставки спрашивать:
   * - 'next-active' — первый активный день начиная с `searchFrom` (обычный cron,
   *   обычно searchFrom = завтра).
   * - 'today-only' — строго сегодня; если сегодня не активный день по расписанию
   *   клиента, клиент пропускается (sameDay cron).
   */
  targetMode: TargetDateMode
  /** Дата, с которой искать активный день для режима 'next-active'. */
  searchFrom: Date
  /** Фильтр клиентов. */
  where: Prisma.ClientWhereInput
  dryRun: boolean
}

/**
 * Разрешает целевую дату доставки для клиента согласно режиму.
 * Возвращает null, если подходящего дня нет (клиент будет пропущен).
 */
async function resolveTargetDate(
  clientId: string,
  opts: RunDailyQuestionsOptions
): Promise<Date | null> {
  if (opts.targetMode === 'today-only') {
    // sameDay: спрашиваем строго про сегодня. Используем тот же scheduler,
    // что и обычный cron, но стартуем поиск с сегодня и принимаем результат
    // ТОЛЬКО если первый активный день == сегодня (иначе сегодня — выходной
    // по расписанию клиента, и same-day-вопрос неуместен).
    const next = await getNextActiveDayForClient(clientId, opts.todayMsk)
    if (!next) return null
    return next.date.getTime() === opts.todayMsk.getTime() ? next.date : null
  }
  const next = await getNextActiveDayForClient(clientId, opts.searchFrom)
  return next ? next.date : null
}

/**
 * Общий прогон рассылки daily-questions. Per-client идемпотентность через
 * @@unique([clientId, deliveryDate]) на BotConversation (P2002 → skipped).
 */
export async function runDailyQuestions(opts: RunDailyQuestionsOptions): Promise<RunResult> {
  const candidates = await prisma.client.findMany({
    where: opts.where,
    select: {
      id: true,
      name: true,
      locations: {
        select: {
          id: true,
          sameDayDelivery: true,
          cutoffHourMsk: true,
          cutoffMinuteMsk: true,
          isActive: true,
        },
      },
    },
  })

  const result: RunResult = {
    total_candidates: candidates.length,
    sent: 0,
    skipped_not_onboarded: 0,
    skipped_existing: 0,
    skipped_no_active_day: 0,
    errors: [],
  }

  for (const client of candidates) {
    try {
      const chatId = await getActiveMaxChatIdForClient(client.id)
      if (!chatId) {
        result.skipped_not_onboarded++
        console.log(`[${opts.label}] skip not-onboarded: ${client.name}`)
        continue
      }

      const targetDate = await resolveTargetDate(client.id, opts)
      if (!targetDate) {
        result.skipped_no_active_day++
        result.errors.push({ clientName: client.name, reason: 'no_active_day' })
        console.log(`[${opts.label}] no active target day: ${client.name}`)
        continue
      }

      const existing = await prisma.botConversation.findFirst({
        where: { clientId: client.id, deliveryDate: targetDate },
        select: { id: true },
      })
      if (existing) {
        result.skipped_existing++
        console.log(
          `[${opts.label}] skip existing conversation: ${client.name} @ ${targetDate.toISOString()}`
        )
        continue
      }

      // 7.51 / F-A: для same-day-вопроса (today-only) подставляем персональный
      // cut-off клиента вместо хардкода «16:00». Несколько same-day локаций →
      // самый ранний. Для NEXT_DAY (next-active) cutoffStr=undefined → «16:00».
      const sameDayCutoff =
        opts.targetMode === 'today-only'
          ? getEarliestSameDayCutoff(client.locations)
          : null
      const cutoffStr = sameDayCutoff ? formatCutoff(sameDayCutoff) : undefined
      const text = getDailyQuestionText(targetDate, opts.todayMsk, cutoffStr)
      const variantIdx = targetDate.getDate() % 7

      if (opts.dryRun) {
        result.sent++
        console.log(
          `[${opts.label}] DRY: would send to ${client.name} (target=${targetDate.toISOString()}): ${text}`
        )
        continue
      }

      const conversation = await prisma.botConversation.create({
        data: {
          clientId: client.id,
          deliveryDate: targetDate,
          status: 'PENDING',
          questionVariant: String(variantIdx),
        },
      })

      await sendBotMessage(chatId, text, { delay: false })

      await prisma.botMessage.create({
        data: {
          clientId: client.id,
          conversationId: conversation.id,
          direction: 'OUT',
          text,
        },
      })

      result.sent++
      console.log(`[${opts.label}] sent to ${client.name} (target=${targetDate.toISOString()})`)
    } catch (err) {
      // Race condition по @@unique([clientId, deliveryDate]) — клиент только что сам написал.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        result.skipped_existing++
        console.log(`[${opts.label}] P2002 race: ${client.name}`)
        continue
      }
      const reason = err instanceof Error ? err.message : String(err)
      result.errors.push({ clientName: client.name, reason })
      console.error(`[${opts.label}] error for ${client.name}:`, reason)
      // 7.12: репорт в in-house tracker (per-client failure, не валит весь cron).
      void import('@/lib/errors/tracker').then((m) =>
        m.trackError({
          error: err,
          extra: { source: `cron/${opts.label}`, clientName: client.name },
        })
      )
    }
  }

  return result
}
