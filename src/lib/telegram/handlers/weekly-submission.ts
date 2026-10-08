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

function lineLabel(date: string, locationName: string | null, multiLocation: boolean): string {
  const day = formatWeeklyDate(date)
  return multiLocation && locationName ? `${day} — ${locationName}` : day
}

/** «34 → 35», «35», «не нужно» — без служебных слов, читается с телефона. */
function portionsChange(prev: number | null | undefined, next: number): string {
  if (next === 0) return prev ? `${prev} → не нужно` : 'не нужно'
  if (prev != null && prev !== next) return `${prev} → ${next}`
  return String(next)
}

/**
 * Итог внесения: «• чт 8 окт — 34 → 35»; невнесённое — отдельным блоком
 * «Не внесено» с причиной. HTML-safe.
 */
export function formatOutcomeLines(outcomes: WeeklyLineOutcome[], multiLocation: boolean): string {
  const done = outcomes.filter((o) => o.result !== 'skipped' && o.result !== 'failed')
  const notDone = outcomes.filter((o) => o.result === 'skipped' || o.result === 'failed')
  const rows: string[] = done.map((o) => {
    const label = escapeHtml(lineLabel(o.date, o.locationName, multiLocation))
    const value =
      o.result === 'cancelled'
        ? 'отменено'
        : o.result === 'unchanged'
          ? `${o.portions} (так и было)`
          : portionsChange(o.prevPortions, o.portions)
    return `• ${label} — ${value}`
  })
  if (notDone.length > 0) {
    if (rows.length > 0) rows.push('')
    rows.push('Не внесено:')
    for (const o of notDone) {
      const label = escapeHtml(lineLabel(o.date, o.locationName, multiLocation))
      rows.push(`• ${label} — ${escapeHtml(o.note ?? 'ошибка')}`)
    }
  }
  return rows.join('\n')
}

function menuNote(applied: WeeklyApplyResult): string {
  if (applied.menuMissingDates.length === 0) return ''
  return `\n\nℹ️ Меню ещё не утверждено на: ${applied.menuMissingDates.map(formatWeeklyDate).join(', ')}`
}

function isMultiLocation(items: Array<{ locationName: string | null }>): boolean {
  return new Set(items.map((i) => i.locationName).filter(Boolean)).size > 1
}

/** Что прислал клиент — одной строкой (фото — ссылкой). */
function sourceLine(source: 'PHOTO' | 'TEXT' | undefined, rawText?: string, blobUrl?: string): string {
  if (source === 'PHOTO') {
    const caption = rawText?.trim() ? ` «${escapeHtml(shorten(rawText, 200))}»` : ''
    return `📷 Фото${caption}${blobUrl ? `: ${escapeHtml(blobUrl)}` : ''}`
  }
  if (!rawText?.trim()) return ''
  return `💬 «${escapeHtml(shorten(rawText, 300))}»`
}

function shorten(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

export function formatAutoAppliedNotification(
  clientName: string,
  applied: WeeklyApplyResult,
  origin: { source?: 'PHOTO' | 'TEXT'; rawText?: string; blobUrl?: string } = {},
): string {
  const src = sourceLine(origin.source, origin.rawText, origin.blobUrl)
  return (
    `✅ ${escapeHtml(clientName)}: внёс заявку\n` +
    (src ? `${src}\n` : '') +
    `\n${formatOutcomeLines(applied.outcomes, isMultiLocation(applied.outcomes))}` +
    menuNote(applied)
  )
}

/** Строка распознанного для проверки: «• чт 8 окт — 34 → 35» / «• ср 7 окт — приём закрыт». */
function reviewLineValue(l: WeeklyLine): string {
  if (l.delta != null && l.prevPortions != null) {
    const sign = l.delta > 0 ? '+' : '−'
    return `${l.prevPortions} → ${l.portions} (${sign}${Math.abs(l.delta)})`
  }
  if (l.delta != null) return `${l.delta > 0 ? '+' : '−'}${Math.abs(l.delta)}`
  if (l.prevPortions != null && l.prevPortions === l.portions) return `${l.portions} (так и было)`
  return portionsChange(l.prevPortions, l.portions)
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
  const multi = isMultiLocation(params.lines.map((l) => ({ locationName: l.config?.locationName ?? null })))
  const label = (l: WeeklyLine) => escapeHtml(lineLabel(l.date, l.config?.locationName ?? null, multi))
  const ok = params.lines.filter((l) => l.status === 'ok')
  const rest = params.lines.filter((l) => l.status !== 'ok')
  const parts: string[] = [`🔍 ${escapeHtml(params.clientName)}: проверьте заявку`]
  const src = sourceLine(params.source, params.rawText, params.blobUrl)
  if (src) parts.push(src)
  parts.push('')
  if (ok.length > 0) {
    parts.push('Если нажать «Внести»:')
    for (const l of ok) parts.push(`• ${label(l)} — ${reviewLineValue(l)}`)
  } else {
    parts.push('Внести нечего.')
  }
  if (rest.length > 0) {
    parts.push('Не внесётся:')
    for (const l of rest) parts.push(`• ${label(l)} — ${escapeHtml(l.note ?? '')}`)
  }
  parts.push('')
  parts.push(`Почему не внёс сам: ${escapeHtml(params.reviewReasons.join('; '))}`)
  if (params.dietaryNotes) parts.push(`Пометки: ${escapeHtml(params.dietaryNotes)}`)
  return parts.join('\n')
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
  source?: 'PHOTO' | 'TEXT'
  rawText?: string
  blobUrl?: string
}): Promise<void> {
  const r = await notifyAllAdminProDirect(
    truncateForTelegram(formatAutoAppliedNotification(params.clientName, params.applied, params)),
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

/** «ХАЛВА: » — чтобы после правки было видно, чья заявка. Сбой — пустая строка. */
async function submissionClientPrefix(submissionId: string): Promise<string> {
  try {
    const sub = await prisma.weeklyOrderSubmission.findUnique({
      where: { id: submissionId },
      select: { client: { select: { name: true } } },
    })
    const name = sub?.client?.name
    return name ? `${escapeHtml(name)}: ` : ''
  } catch (err) {
    console.error('[weekly-submission] load client name failed', err)
    return ''
  }
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
    // Снимаем спиннер с кнопки ДО медленной работы (ответ клиенту, правка).
    const answer = async (args: { text: string; show_alert?: boolean }) => {
      try {
        await ctx.answerCallbackQuery(args)
      } catch (err) {
        console.error('[weekly-submission] answerCallbackQuery failed', err)
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
      await answer({ text: 'Внесено' })
      const client = await prisma.client.findUnique({
        where: { id: result.clientId },
        select: { name: true },
      })
      const clientReply = formatClientAppliedReply(result.applied.outcomes, 'Заявку подтвердили')
      let clientNote = ''
      if (clientReply) {
        const chatId = await getActiveMaxChatIdForClient(result.clientId)
        let sent = false
        if (chatId) {
          sent = await sendBotMessage(chatId, clientReply, { delay: false }).then(
            () => true,
            (e) => {
              console.error('[weekly-submission] client reply failed', e)
              return false
            },
          )
        }
        clientNote = sent ? '\n\nКлиенту отправлено.' : '\n\n⚠️ Клиенту не отправилось — напиши ему сам.'
      }
      await edit(
        `✅ ${escapeHtml(client?.name ?? '')}: внесено\n\n` +
          `${formatOutcomeLines(result.applied.outcomes, isMultiLocation(result.applied.outcomes))}` +
          menuNote(result.applied) +
          clientNote,
        result.applied.applyLogId,
      )
      return
    }

    if (action === 'reject') {
      const r = await rejectWeeklySubmission({ submissionId: id, rejectedById: user.id })
      if (!r.ok) {
        // Не затираем сообщение: в нём таблица заявки, она нужна для разбора.
        await answer({ text: 'Уже обработано', show_alert: true })
        return
      }
      await answer({ text: 'Отклонено' })
      const who = await submissionClientPrefix(id)
      await edit(
        r.keptPrevious
          ? `❌ ${who}повторная заявка отклонена. Ранее внесённое по этой неделе не трогали.`
          : `❌ ${who}заявка отклонена, заказы не вносились.`,
      )
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
      await answer({ text: 'Отменено' })
      const who = await submissionClientPrefix(r.submissionId)
      const failed = r.results.filter((x) => !x.ok)
      await edit(
        `↩️ ${who}внесение отменено: вернули ${r.results.length - failed.length} заказ(ов) к прежним значениям.` +
          (failed.length
            ? `\n⚠️ Не откатили: ${failed.map((f) => `${f.orderId} (${escapeHtml(f.note ?? '')})`).join(', ')} — свяжись с шефом.`
            : ''),
      )
      return
    }

    if (action === 'cancel') {
      // Legacy-кнопка «Отменить заявку» со старых сообщений.
      const { cancelled, notCancelled } = await cancelWeeklySubmission({
        submissionId: id,
        cancelledById: user.id,
      })
      await answer({ text: 'Готово' })
      const who = await submissionClientPrefix(id)
      await edit(
        `❌ ${who}заявка отменена. Откатили ` +
          cancelled +
          ' заказов в DRAFT.' +
          (notCancelled.length
            ? '\n⚠️ Уже в производстве и не тронуты: ' +
              notCancelled.map((o) => o.orderId).join(', ') +
              ' — свяжись с шефом.'
            : ''),
      )
      return
    }

    await ctx.answerCallbackQuery({ text: 'Неизвестное действие' })
  },
})
