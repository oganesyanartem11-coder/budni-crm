import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getNextActiveDayForClient } from '@/lib/db/queries/bot'
import { getDailyQuestionText } from '@/lib/bot/templates'
import { getEarliestSameDayCutoff, formatCutoff } from '@/lib/utils/cutoff'
import { sendBotMessage } from '@/lib/max/send-message'
import { getActiveMaxChatIdForClient } from '@/lib/bot/max-users'
import { isScheduledForDate } from '@/lib/orders/generate-orders'
import type { MealType, OrderStatus } from '@prisma/client'

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
  /** Число на целевую дату уже стоит (клиент написал раньше / менеджер / Борис). */
  skipped_already_answered: number
  /** Повторная отправка на conv, где вопрос раньше не ушёл (send упал). */
  resent_unsent: number
  errors: ErrorEntry[]
}

/**
 * «Same-day клиент» = есть АКТИВНАЯ same-day локация, на которой есть активное
 * DYNAMIC-питание (только про такие локации бот спрашивает утром о сегодня).
 * Деактивированная same-day точка или same-day точка только с FIXED-питанием
 * клиента same-day НЕ делают — иначе его спрашивали бы в 07:40 о сегодня и
 * никогда о завтра. Один предикат на выбор кандидатов обоих cron'ов и на
 * исключения в напоминаниях / cutoff-notice / production-summary.
 */
export const SAME_DAY_DYNAMIC_LOCATION: Prisma.ClientLocationWhereInput = {
  sameDayDelivery: true,
  isActive: true,
  mealConfigs: { some: { orderType: 'DYNAMIC', isActive: true } },
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
    // DYNAMIC-питание только на активной точке (генератор неактивные не трогает).
    mealConfigs: { some: { orderType: 'DYNAMIC', isActive: true, location: { isActive: true } } },
    locations: sameDayOnly
      ? { some: SAME_DAY_DYNAMIC_LOCATION }
      : { none: SAME_DAY_DYNAMIC_LOCATION },
  }
}

/**
 * Статусы, при которых число на дату уже «стоит»: подтверждено или дальше по
 * конвейеру. PENDING/DRAFT (0-заглушки генератора) и CANCELLED — не ответ.
 */
const SETTLED_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
])

export interface OrderKey {
  locationId: string
  mealType: MealType
}

/**
 * Чистая функция: по КАЖДОМУ ключу (точка × приём пищи) есть заказ с числом > 0
 * в статусе CONFIRMED или дальше. Пустой список ключей → false (спрашивать).
 */
export function allKeysSettled(
  keys: OrderKey[],
  orders: Array<{ locationId: string; mealType: MealType; portions: number; status: OrderStatus }>,
): boolean {
  if (keys.length === 0) return false
  return keys.every((k) =>
    orders.some(
      (o) =>
        o.locationId === k.locationId &&
        o.mealType === k.mealType &&
        o.portions > 0 &&
        SETTLED_ORDER_STATUSES.has(o.status),
    ),
  )
}

async function loadOrdersForKeys(clientId: string, deliveryDate: Date) {
  return prisma.order.findMany({
    where: { clientId, deliveryDate, status: { in: [...SETTLED_ORDER_STATUSES] } },
    select: { locationId: true, mealType: true, portions: true, status: true },
  })
}

/**
 * Число на дату уже дано по всем DYNAMIC-питаниям клиента на эту дату
 * (клиент написал «на завтра 7» утром, менеджер/Борис поставил вручную).
 * Тогда вопрос, напоминания и «приём закрыт» ему не нужны.
 * `keys` — если уже известны (из getNextActiveDayForClient), иначе грузим сами.
 */
export async function isDeliveryDateAnswered(
  clientId: string,
  deliveryDate: Date,
  keys?: OrderKey[],
): Promise<boolean> {
  let k = keys
  if (!k) {
    const configs = await prisma.clientMealConfig.findMany({
      where: { clientId, isActive: true, orderType: 'DYNAMIC', location: { isActive: true } },
    })
    k = configs
      .filter((c) => isScheduledForDate(c, deliveryDate))
      .map((c) => ({ locationId: c.locationId, mealType: c.mealType }))
  }
  if (k.length === 0) return false
  return allKeysSettled(k, await loadOrdersForKeys(clientId, deliveryDate))
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
): Promise<{ date: Date; keys: OrderKey[] } | null> {
  const toResult = (next: Awaited<ReturnType<typeof getNextActiveDayForClient>>) =>
    next
      ? {
          date: next.date,
          keys: next.configs.map((c) => ({ locationId: c.locationId, mealType: c.mealType })),
        }
      : null
  if (opts.targetMode === 'today-only') {
    // sameDay: спрашиваем строго про сегодня. Используем тот же scheduler,
    // что и обычный cron, но стартуем поиск с сегодня и принимаем результат
    // ТОЛЬКО если первый активный день == сегодня (иначе сегодня — выходной
    // по расписанию клиента, и same-day-вопрос неуместен).
    const next = await getNextActiveDayForClient(clientId, opts.todayMsk)
    if (!next) return null
    return next.date.getTime() === opts.todayMsk.getTime() ? toResult(next) : null
  }
  return toResult(await getNextActiveDayForClient(clientId, opts.searchFrom))
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
    skipped_already_answered: 0,
    resent_unsent: 0,
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

      const target = await resolveTargetDate(client.id, opts)
      if (!target) {
        result.skipped_no_active_day++
        result.errors.push({ clientName: client.name, reason: 'no_active_day' })
        console.log(`[${opts.label}] no active target day: ${client.name}`)
        continue
      }
      const targetDate = target.date

      const existing = await prisma.botConversation.findFirst({
        where: { clientId: client.id, deliveryDate: targetDate },
        select: { id: true, status: true, messages: { select: { id: true }, take: 1 } },
      })
      // Conv есть, но в ней ни одного сообщения и она PENDING — прошлый прогон
      // создал её, а sendBotMessage упал. Это «ещё не спросили»: шлём вопрос в
      // ЭТУ же conv (новую не создаём — @@unique([clientId, deliveryDate])).
      const unsentConv =
        existing && existing.status === 'PENDING' && existing.messages.length === 0 ? existing : null
      if (existing && !unsentConv) {
        result.skipped_existing++
        console.log(
          `[${opts.label}] skip existing conversation: ${client.name} @ ${targetDate.toISOString()}`
        )
        continue
      }

      // Число на эту дату уже стоит по всем DYNAMIC-питаниям (клиент написал
      // заранее «на завтра 7», менеджер/Борис поставил) — не спрашиваем. Conv
      // не создаём → напоминания 14:00/15:30 и «приём закрыт» 16:00 (работают
      // по PENDING-conv) его тоже не тронут.
      if (await isDeliveryDateAnswered(client.id, targetDate, target.keys)) {
        result.skipped_already_answered++
        console.log(
          `[${opts.label}] skip already answered: ${client.name} @ ${targetDate.toISOString()}`
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

      const conversation =
        unsentConv ??
        (await prisma.botConversation.create({
          data: {
            clientId: client.id,
            deliveryDate: targetDate,
            status: 'PENDING',
            questionVariant: String(variantIdx),
          },
        }))

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
      if (unsentConv) result.resent_unsent++
      console.log(
        `[${opts.label}] ${unsentConv ? 're-sent (prev send failed)' : 'sent'} to ${client.name} (target=${targetDate.toISOString()})`
      )
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
