import { prisma } from '@/lib/db/prisma'
import {
  applyReviewedSubmission,
  cancelWeeklySubmission,
  rejectWeeklySubmission,
  undoWeeklyApply,
  type WeeklyApplyResult,
  type WeeklyLineOutcome,
} from '@/lib/weekly/actions'
import { formatWeeklyDate, type WeeklyLine } from '@/lib/weekly/sanity-checks'
import { getActiveMaxChatIdForClient } from '@/lib/bot/max-users'
import { sendBotMessage } from '@/lib/max/send-message'
import { createInboxItem } from '@/lib/bot/create-inbox-item'
import { registerCallbackHandler } from '../callback-router'
import { notifyAllAdminProDirect, escapeHtml } from '../notify'
import { weeklyApplyUndoButton, weeklySubmissionReviewButtons } from '../buttons'

/**
 * TG-часть недельных заявок (scope 'wsub'):
 *  - внесено автоматически → итог по строкам + «↩️ Отменить» (wsub:undo:<applyLogId>);
 *  - ручная проверка → таблица распознанного, причина + «✅ Внести как
 *    распознано» (wsub:apply) / «❌ Отклонить» (wsub:reject);
 *  - wsub:cancel — legacy-кнопка старых сообщений.
 * Регистрация callback — side-effect импорта в bot.ts.
 */

const RESULT_LABEL: Record<WeeklyLineOutcome['result'], string> = {
  created: 'внесено',
  updated: 'обновлено',
  confirmed: 'внесено',
  cancelled: 'отменено',
  unchanged: 'без изменений',
  noop: 'заказа не было',
  skipped: 'пропущено',
  failed: 'НЕ получилось',
}

function lineLabel(date: string, locationName: string | null, multiLocation: boolean): string {
  const day = formatWeeklyDate(date)
  return multiLocation && locationName ? `${day} — ${locationName}` : day
}

/** Строки итога: «пн 5 окт — 30 (обновлено)», для пропусков — с причиной. HTML-safe. */
export function formatOutcomeLines(outcomes: WeeklyLineOutcome[], multiLocation: boolean): string {
  return outcomes
    .map((o) => {
      const label = escapeHtml(lineLabel(o.date, o.locationName, multiLocation))
      const value = o.portions === 0 ? 'не нужно' : String(o.portions)
      const note = o.note ? `: ${escapeHtml(o.note)}` : ''
      return `${label} — ${value} (${RESULT_LABEL[o.result]}${note})`
    })
    .join('\n')
}

function menuNote(applied: WeeklyApplyResult): string {
  if (applied.menuMissingDates.length === 0) return ''
  return `\n\nℹ️ Меню ещё не утверждено на: ${applied.menuMissingDates.map(formatWeeklyDate).join(', ')}`
}

function isMultiLocation(items: Array<{ locationName: string | null }>): boolean {
  return new Set(items.map((i) => i.locationName).filter(Boolean)).size > 1
}

export function formatAutoAppliedNotification(clientName: string, applied: WeeklyApplyResult): string {
  return (
    `✅ ${escapeHtml(clientName)} прислал заявку на неделю — внесено:\n` +
    `${formatOutcomeLines(applied.outcomes, isMultiLocation(applied.outcomes))}` +
    menuNote(applied)
  )
}

export function formatReviewNotification(params: {
  clientName: string
  lines: WeeklyLine[]
  reviewReasons: string[]
  source: 'PHOTO' | 'TEXT'
  blobUrl?: string
  rawText?: string
  dietaryNotes: string | null
}): string {
  const table = params.lines.length
    ? params.lines
        .map((l) => {
          const point = l.config?.locationName ?? '?'
          const value = l.portions === 0 ? 'не нужно' : String(l.portions)
          const note = l.note ? ` (${escapeHtml(l.note)})` : ''
          return `${escapeHtml(formatWeeklyDate(l.date))} — ${escapeHtml(point)} — ${value}${note}`
        })
        .join('\n')
    : '—'
  const sourceLine =
    params.source === 'PHOTO'
      ? `фото ${escapeHtml(params.blobUrl ?? '')}`
      : `текст: ${escapeHtml((params.rawText ?? '').slice(0, 1000))}`
  return (
    `🔍 ${escapeHtml(params.clientName)}: заявка требует проверки.\n\n` +
    `Почему не автоматически: ${escapeHtml(params.reviewReasons.join('; '))}\n\n` +
    `Распознано (дата — точка — порции):\n${table}\n\n` +
    (params.dietaryNotes ? `Пометки: ${escapeHtml(params.dietaryNotes)}\n` : '') +
    `Источник: ${sourceLine}`
  )
}

/**
 * Доставлено ли хоть одному ADMIN_PRO: да → managerNotifiedAt; нет → заявка
 * не должна потеряться тихо — InboxItem HIGH с пометкой.
 */
async function markNotified(submissionId: string, sentTo: number, what: string): Promise<void> {
  if (sentTo > 0) {
    await prisma.weeklyOrderSubmission.update({
      where: { id: submissionId },
      data: { managerNotifiedAt: new Date() },
    })
    return
  }
  const submission = await prisma.weeklyOrderSubmission.findUnique({
    where: { id: submissionId },
    select: { clientId: true },
  })
  if (!submission) return
  await createInboxItem({
    clientId: submission.clientId,
    reason: 'NON_NUMERIC',
    humanReason: `${what} — уведомление в Telegram не доставлено ни одному ADMIN_PRO`,
    priority: 'HIGH',
  })
}

export async function notifyManagersWeeklyApplied(params: {
  submissionId: string
  clientName: string
  applied: WeeklyApplyResult
}): Promise<void> {
  const r = await notifyAllAdminProDirect(
    truncateForTelegram(formatAutoAppliedNotification(params.clientName, params.applied)),
    { replyMarkup: weeklyApplyUndoButton(params.applied.applyLogId) },
  )
  await markNotified(params.submissionId, r.sentTo, 'Недельная заявка внесена автоматически')
}

export async function notifyManagersWeeklyReview(
  params: Parameters<typeof formatReviewNotification>[0] & { submissionId: string },
): Promise<void> {
  const r = await notifyAllAdminProDirect(truncateForTelegram(formatReviewNotification(params)), {
    replyMarkup: weeklySubmissionReviewButtons(params.submissionId),
  })
  await markNotified(params.submissionId, r.sentTo, 'Недельная заявка ждёт проверки')
}

/** Telegram режет >4096 — обрезаем по строке (теги в наших строках однострочные). */
function truncateForTelegram(text: string, limit = 4000): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  return `${cut.slice(0, cut.lastIndexOf('\n'))}\n…`
}

/** Пропущенные/невнесённые дни для клиента: «пн 5 окт (приём на эту дату уже закрыт)». */
export function formatClientSkippedList(outcomes: WeeklyLineOutcome[]): string {
  const multi = isMultiLocation(outcomes)
  return outcomes
    .filter((o) => o.result === 'skipped' || o.result === 'failed')
    .map((o) => {
      const label = lineLabel(o.date, o.locationName, multi)
      return o.result === 'skipped' && o.note ? `${label} (${o.note})` : label
    })
    .join(', ')
}

/**
 * Ответ клиенту после внесения: что внесли и что не смогли. null — не внесено
 * ничего (тогда клиенту «менеджер проверит», менеджер видит причины).
 */
export function formatClientAppliedReply(
  outcomes: WeeklyLineOutcome[],
  prefix = 'Принято! Внесли заявку',
): string | null {
  const list = formatClientAppliedList(outcomes)
  if (!list) return null
  const skipped = formatClientSkippedList(outcomes)
  return `${prefix}: ${list}.` + (skipped ? ` Не смогли внести: ${skipped} — менеджер свяжется, если нужно.` : '')
}

/** Ответ клиенту о внесённом: «пн 5 окт — 30, вт 6 окт — не нужно». */
export function formatClientAppliedList(outcomes: WeeklyLineOutcome[]): string {
  const multi = isMultiLocation(outcomes)
  return outcomes
    .filter((o) => o.result !== 'skipped' && o.result !== 'failed')
    .map((o) => `${lineLabel(o.date, o.locationName, multi)} — ${o.portions === 0 ? 'не нужно' : o.portions}`)
    .join(', ')
}

async function findAdminPro(telegramId: number | undefined) {
  if (!telegramId) return null
  return prisma.user.findFirst({
    where: { telegramChatId: String(telegramId), role: 'ADMIN_PRO', isActive: true },
    select: { id: true, role: true },
  })
}

registerCallbackHandler({
  scope: 'wsub',
  async handle(ctx, action, id) {
    const user = await findAdminPro(ctx.from?.id)
    if (!user) {
      await ctx.answerCallbackQuery({ text: 'Только для ADMIN_PRO', show_alert: true })
      return
    }

    const edit = async (text: string, withUndoLogId?: string) => {
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          ...(withUndoLogId ? { reply_markup: weeklyApplyUndoButton(withUndoLogId) } : {}),
        })
      } catch (err) {
        console.error('[weekly-submission] editMessageText failed', err)
      }
    }

    if (action === 'apply') {
      const result = await applyReviewedSubmission({ submissionId: id, actor: user })
      if (!result.ok) {
        await ctx.answerCallbackQuery({
          text: result.reason === 'not_found' ? 'Заявка не найдена' : 'Уже обработано',
          show_alert: true,
        })
        return
      }
      const client = await prisma.client.findUnique({
        where: { id: result.clientId },
        select: { name: true },
      })
      await edit(
        `✅ ${escapeHtml(client?.name ?? '')}: заявка внесена по распознанному.\n` +
          `${formatOutcomeLines(result.applied.outcomes, isMultiLocation(result.applied.outcomes))}` +
          menuNote(result.applied),
        result.applied.applyLogId,
      )
      const clientReply = formatClientAppliedReply(result.applied.outcomes, 'Заявку подтвердили')
      const chatId = await getActiveMaxChatIdForClient(result.clientId)
      if (chatId && clientReply) {
        await sendBotMessage(chatId, clientReply).catch((e) =>
          console.error('[weekly-submission] client reply failed', e),
        )
      }
      await ctx.answerCallbackQuery({ text: 'Внесено' })
      return
    }

    if (action === 'reject') {
      const r = await rejectWeeklySubmission({ submissionId: id, rejectedById: user.id })
      await edit(
        !r.ok
          ? 'Уже обработано'
          : r.keptPrevious
            ? '❌ Повторная заявка отклонена. Ранее внесённое по этой неделе не трогали.'
            : '❌ Заявка отклонена, заказы не вносились.',
      )
      await ctx.answerCallbackQuery({ text: r.ok ? 'Отклонено' : 'Уже обработано' })
      return
    }

    if (action === 'undo') {
      const r = await undoWeeklyApply({ applyLogId: id, actor: user })
      if (!r.ok) {
        await ctx.answerCallbackQuery({
          text: r.reason === 'already_undone' ? 'Уже отменено' : 'Не найдено',
          show_alert: true,
        })
        return
      }
      const failed = r.results.filter((x) => !x.ok)
      await edit(
        `↩️ Внесение отменено: вернули ${r.results.length - failed.length} заказ(ов) к прежним значениям.` +
          (failed.length
            ? `\n⚠️ Не откатили: ${failed.map((f) => `${f.orderId} (${escapeHtml(f.note ?? '')})`).join(', ')} — свяжись с шефом.`
            : ''),
      )
      await ctx.answerCallbackQuery({ text: 'Отменено' })
      return
    }

    if (action === 'cancel') {
      // Legacy-кнопка «Отменить заявку» со старых сообщений.
      const { cancelled, notCancelled } = await cancelWeeklySubmission({
        submissionId: id,
        cancelledById: user.id,
      })
      await edit(
        '❌ Заявка отменена. Откатили ' +
          cancelled +
          ' заказов в DRAFT.' +
          (notCancelled.length
            ? '\n⚠️ Уже в производстве и не тронуты: ' +
              notCancelled.map((o) => o.orderId).join(', ') +
              ' — свяжись с шефом.'
            : ''),
      )
      await ctx.answerCallbackQuery({ text: 'Готово' })
      return
    }

    await ctx.answerCallbackQuery({ text: 'Неизвестное действие' })
  },
})
