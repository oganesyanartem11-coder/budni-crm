import { prisma } from '@/lib/db/prisma'
import { notifyAlertRecipients, escapeHtml } from '@/lib/telegram/notify'
import { inboxButton } from '@/lib/telegram/buttons'
import type { ToneLabel } from '@/lib/inbox/tone-labels'

/**
 * 7.15.B: единый канал Telegram-алёртов о клиентах.
 *
 * Объединяет старые notifyManagersAboutInboxItem (5.x — пуш по InboxItem)
 * и notifyToneAlert (7.15 — пуш по tone). Один шаблон, один cooldown,
 * один лог через ClientAlertLog.
 *
 * Cooldown: 2 мин per-client — только против повторов ОДНОГО И ТОГО ЖЕ сигнала.
 * Пробивают cooldown:
 *  - новый InboxItem (inboxItemId не null и ещё не алёртился в окне) — это
 *    новая работа менеджеру, глушить её нельзя;
 *  - priority=HIGH (кроме повтора того же InboxItem);
 *  - эскалация rude→urgent. Обратно (urgent→rude) — нет.
 * Чистые tone-повторы (без нового InboxItem) по-прежнему гасятся.
 *
 * Title-приоритет: urgent > HIGH-priority > rude > NORMAL.
 *
 * Без сигнала (нет tone и нет inboxItemId) — silent skip.
 */

const CLIENT_ALERT_COOLDOWN_MIN = 2

const REASON_RU: Record<string, string> = {
  NEW_CLIENT: 'Новый клиент',
  ANOMALY_HISTORICAL: 'Изменение от обычного',
  ANOMALY_THRESHOLD: 'Цифра вне нормы',
  ANOMALY_LLM_CONFIDENCE: 'LLM не уверен в парсинге',
  NON_NUMERIC: 'Не цифровой ответ',
  CANCELLATION_INTENT: 'Клиент хочет отменить',
  POST_CUTOFF: 'Сообщение после приёма заявок',
}

export interface ClientSignalInput {
  clientId: string
  messageText: string
  inboxItemId?: string | null
  /** Только 'rude' | 'urgent' триггерят алёрт; neutral/thanks/null — без tone-сигнала. */
  tone?: ToneLabel | null
  /** InboxItemReason value (или null если алёрт не привязан к InboxItem). */
  reason?: string | null
  priority?: 'HIGH' | 'NORMAL' | null
  /**
   * Фактический cut-off клиента для POST_CUTOFF («15:00»). Нет — нейтральное
   * «после приёма заявок» (у клиентов разный cut-off, 16:00 — не для всех).
   */
  cutoffLabel?: string | null
}

type RecentAlert = { tone: string | null; inboxItemId: string | null; priority: string | null }

/**
 * Решение cooldown. Возвращает причину прорыва или null (= глушим).
 * recent — алёрты клиента за окно cooldown, новые первыми.
 */
export function cooldownBreakthrough(
  recent: RecentAlert[],
  input: Pick<ClientSignalInput, 'inboxItemId' | 'tone' | 'priority'>,
): 'no_recent' | 'new_inbox_item' | 'high_priority' | 'escalation' | null {
  if (recent.length === 0) return 'no_recent'
  const { inboxItemId, tone, priority } = input
  const sameInboxAlerted = !!inboxItemId && recent.some((a) => a.inboxItemId === inboxItemId)
  if (inboxItemId && !sameInboxAlerted) return 'new_inbox_item'
  if (priority === 'HIGH' && !sameInboxAlerted) return 'high_priority'
  const wasUrgent = recent[0].tone === 'urgent'
  if (tone === 'urgent' && !wasUrgent) return 'escalation'
  return null
}

export async function notifyClientSignal(input: ClientSignalInput): Promise<void> {
  const { clientId, messageText, inboxItemId, tone, reason, priority } = input

  console.log(
    `[bot] alert START: client=${clientId} tone=${tone ?? 'none'} ` +
      `reason=${reason ?? 'none'} priority=${priority ?? 'none'}`
  )

  const hasTone = tone === 'rude' || tone === 'urgent'
  const hasInbox = !!inboxItemId
  if (!hasTone && !hasInbox) {
    console.log('[bot] alert SKIPPED: no signal (no rude/urgent tone, no inboxItem)')
    return
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true },
  })
  if (!client) {
    console.warn(`[bot] alert: client ${clientId} not found`)
    return
  }

  // Cooldown: 2 мин per-client; новый InboxItem / HIGH / эскалация пробивают.
  const recentAlerts: RecentAlert[] = await prisma.clientAlertLog.findMany({
    where: {
      clientId,
      createdAt: { gte: new Date(Date.now() - CLIENT_ALERT_COOLDOWN_MIN * 60_000) },
    },
    orderBy: { createdAt: 'desc' },
    select: { tone: true, inboxItemId: true, priority: true },
  })
  const breakthrough = cooldownBreakthrough(recentAlerts, { inboxItemId, tone, priority })
  if (!breakthrough) {
    console.log(
      `[bot] alert SKIPPED (cooldown): client=${clientId} lastTone=${recentAlerts[0]?.tone ?? 'none'} ` +
        `inboxItem=${inboxItemId ?? 'none'}`
    )
    return
  }
  if (breakthrough !== 'no_recent') {
    console.log(`[bot] alert PROCEEDS (cooldown breakthrough: ${breakthrough}): client=${clientId}`)
  }

  // Title-приоритет: urgent > HIGH > rude > NORMAL.
  let titleEmoji = '🔔'
  let titleText = 'Новое в Inbox'
  if (tone === 'urgent') {
    titleEmoji = '🚨'
    titleText = 'Срочно'
  } else if (priority === 'HIGH') {
    titleEmoji = '🔴'
    titleText = 'Новое в Inbox'
  } else if (tone === 'rude') {
    titleEmoji = '😠'
    titleText = 'Недоволен'
  }

  const preview = messageText.length > 200 ? messageText.slice(0, 197) + '…' : messageText

  let text: string
  if (reason === 'POST_CUTOFF' && tone !== 'rude' && tone !== 'urgent') {
    // #2: человечный пуш «после cut-off» вместо генерик «Новое в Inbox».
    // Заказ уже принят — менеджеру нужен сам факт + текст, без формальной «Причины».
    // Cut-off у клиентов разный: реальный — если передан, иначе нейтрально.
    const after = input.cutoffLabel ? `после ${escapeHtml(input.cutoffLabel)}` : 'после приёма заявок'
    text =
      `⏰ <b>${escapeHtml(client.name)}</b> написал ${after}:\n` +
      `<i>«${escapeHtml(preview)}»</i>`
  } else {
    const lines: string[] = []
    lines.push(`${titleEmoji} <b>${titleText}</b>: ${escapeHtml(client.name)}`)
    lines.push('')

    const meta: string[] = []
    if (reason && REASON_RU[reason]) {
      meta.push(`Причина: ${REASON_RU[reason]}`)
    }
    // Tone-строка нужна только когда title не отражает tone напрямую
    // (т.е. title=rude/urgent уже всё сказали; title=HIGH/NORMAL — дополним).
    if (tone === 'rude' && titleText !== 'Недоволен') {
      meta.push('Тон: 😠 Недоволен')
    } else if (tone === 'urgent' && titleText !== 'Срочно') {
      meta.push('Тон: 🚨 Срочно')
    }
    if (meta.length > 0) {
      lines.push(...meta)
      lines.push('')
    }

    lines.push(`<i>«${escapeHtml(preview)}»</i>`)

    text = lines.join('\n')
  }

  const result = await notifyAlertRecipients(text, {
    parseMode: 'HTML',
    replyMarkup: inboxButton(clientId),
  })

  await prisma.clientAlertLog.create({
    data: {
      clientId,
      inboxItemId: inboxItemId ?? null,
      tone: tone ?? null,
      reason: reason ?? null,
      priority: priority ?? null,
    },
  })

  // MEGA-AUDIT-FIX-1 C3 (D-7): схема ClientAlertLog не содержит recipientsCount
  // (миграции в этом блоке запрещены), поэтому фактическое sentTo пишем явным
  // ERROR-логом — нулевой охват = потеря сигнала, должен быть виден в логах.
  if (result.sentTo === 0) {
    console.error(
      `[client-signal] LOST: clientId=${clientId} tone=${tone ?? 'none'} sentTo=0`
    )
  }

  console.log(
    `[bot] alert DONE: client=${clientId} sentTo=${result.sentTo} ` +
      `skippedNoTelegram=${result.skippedNoTelegram} failed=${result.failed}`
  )
}
