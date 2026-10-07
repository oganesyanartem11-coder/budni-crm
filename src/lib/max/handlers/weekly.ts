import { put } from '@vercel/blob'
import { sendBotMessage } from '@/lib/max/send-message'
import { promoteToActiveByChatId } from '@/lib/bot/max-users'
import { createInboxItem } from '@/lib/bot/create-inbox-item'
import { notifyClientSignal } from '@/lib/bot/notify-client-signal'
import { fetchAttachmentAsBase64 } from '@/lib/max/fetch-attachment'
import { parseWeeklySubmission } from '@/lib/weekly/parser'
import {
  loadUpcomingWeeklyOrders,
  loadWeeklyConfigOptions,
  processWeeklySubmission,
} from '@/lib/weekly/actions'
import {
  formatClientAppliedReply,
  notifyManagersWeeklyApplied,
  notifyManagersWeeklyReview,
} from '@/lib/telegram/handlers/weekly-submission'
import type { ClientWithBotContext } from '@/lib/db/queries/bot'
import type { ParseResult } from '@/lib/weekly/parser'

/**
 * Приём недельной заявки WEEKLY-клиента в MAX-вебхуке.
 * Фото бумажного списка или SMS-текст → parser → построчный разбор → чистая
 * заявка вносится сразу (менеджеру итог + «↩️ Отменить»), иначе — менеджеру
 * на проверку с кнопками «Внести как распознано» / «Отклонить».
 *
 * Повторная заявка на ту же неделю не блокируется: upsert по
 * (clientId, weekStartDate) и применение заново (строки идемпотентны).
 */

const REPLY_REVIEW = 'Спасибо, заявку получили, менеджер проверит и подтвердит.'

/**
 * Контекст парсера: точки WEEKLY-конфигов (locationId нужен только при
 * нескольких точках) и уже внесённые заказы — «с 7 октября добавьте 1»
 * раскладывается по дням, где заказ есть.
 */
async function parserContext(clientId: string, clientName: string, now: Date) {
  const configs = await loadWeeklyConfigOptions(clientId)
  const seen = new Map<string, string>()
  for (const c of configs) seen.set(c.locationId, c.locationName)
  const { list } = await loadUpcomingWeeklyOrders(clientId, configs, now)
  return {
    now,
    clientName,
    locations: [...seen].map(([id, name]) => ({ id, name })),
    existingOrders: list,
  }
}

/** Общий хвост: разбор → внесение/проверка → уведомления → ответ клиенту. */
async function finalizeSubmission(params: {
  client: ClientWithBotContext
  source: 'PHOTO' | 'TEXT'
  blobUrl?: string
  rawText: string | null
  parsed: ParseResult
  // 7.55: chatId отправителя — ответ идёт тому, кто прислал заявку.
  chatId: string
}): Promise<void> {
  const { client, source, blobUrl, rawText, parsed, chatId } = params

  const result = await processWeeklySubmission({
    clientId: client.id,
    source,
    blobUrl,
    rawText: rawText ?? undefined,
    parsedResult: parsed,
  })

  // Ни одной строки заявки («спасибо», вопрос, нечитаемое фото): заявку не
  // трогаем, сообщение — менеджеру в inbox. На текст не отвечаем (это может быть
  // просто разговор), на фото — что получили.
  if (result.submissionId === null) {
    const inbox = await createInboxItem({
      clientId: client.id,
      reason: 'NON_NUMERIC',
      humanReason:
        source === 'PHOTO'
          ? `Фото от недельного клиента — заявку не распознал (${parsed.reason || 'нет строк'}). ${blobUrl ?? ''}`.trim()
          : 'Сообщение недельного клиента без заявки',
      priority: 'NORMAL',
      clientMessage: rawText,
    })
    await notifyClientSignal({
      clientId: client.id,
      messageText: rawText ?? '[фото]',
      inboxItemId: inbox.id,
      tone: null,
      reason: inbox.reason,
      priority: inbox.priority,
    }).catch((e) => console.error('[weekly] notifyClientSignal failed:', e))
    if (source === 'PHOTO') await sendBotMessage(chatId, REPLY_REVIEW)
    return
  }

  // Заказы уже внесены/заявка сохранена — сбой уведомления или ответа ниже не
  // должен превращаться в «заявка не обработана» (менеджер внёс бы её второй раз).
  const submissionId = result.submissionId
  const reply = result.applied
    ? (formatClientAppliedReply(result.applied.outcomes) ?? REPLY_REVIEW)
    : REPLY_REVIEW
  try {
    if (result.applied) {
      await notifyManagersWeeklyApplied({
        submissionId,
        clientName: client.name,
        applied: result.applied,
        source,
        rawText: rawText ?? undefined,
        blobUrl,
      })
    } else {
      await notifyManagersWeeklyReview({
        submissionId,
        clientName: client.name,
        lines: result.lines,
        reviewReasons: result.reviewReasons,
        source,
        blobUrl,
        rawText: rawText ?? undefined,
        dietaryNotes: parsed.dietaryNotes,
      })
    }
  } catch (err) {
    console.error('[weekly] manager notification failed after save:', err)
  }

  await sendBotMessage(chatId, reply).catch((e) => console.error('[weekly] client reply failed:', e))

  // 7.55: недельная заявка (content-bearing) → отправитель становится
  // активным пользователем клиента. Идемпотентно.
  await promoteToActiveByChatId(chatId).catch((e) => console.error('[weekly] promote failed:', e))
}

/**
 * Фото-заявка: скачиваем оригинал → blob → парсер(photo) → общий хвост.
 */
export async function handleWeeklyPhotoSubmission(params: {
  client: ClientWithBotContext
  attachmentUrl: string
  caption?: string
  chatId: string
}): Promise<void> {
  const { client, attachmentUrl, caption, chatId } = params

  const { base64, buffer, mediaType } = await fetchAttachmentAsBase64(attachmentUrl)

  // Оригинальные байты (Buffer), не base64-строку — как в invoice-blob route.
  const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg'
  const pathname = `weekly-submissions/${client.id}/${Date.now()}.${ext}`
  const blob = await put(pathname, buffer, { access: 'public', contentType: mediaType })

  const parsed = await parseWeeklySubmission(
    { type: 'photo', base64, mediaType },
    await parserContext(client.id, client.name, new Date())
  )

  await finalizeSubmission({
    client,
    source: 'PHOTO',
    blobUrl: blob.url,
    rawText: caption ?? null,
    parsed,
    chatId,
  })
}

/**
 * Текстовая (SMS-style) заявка: парсер(text) → общий хвост. Без blob.
 */
export async function handleWeeklyTextSubmission(params: {
  client: ClientWithBotContext
  text: string
  chatId: string
}): Promise<void> {
  const { client, text, chatId } = params

  const parsed = await parseWeeklySubmission(
    { type: 'text', text },
    await parserContext(client.id, client.name, new Date())
  )

  await finalizeSubmission({
    client,
    source: 'TEXT',
    rawText: text,
    parsed,
    chatId,
  })
}
