import { prisma } from '@/lib/db/prisma'
import { put } from '@vercel/blob'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import { createInboxItem } from '@/lib/bot/create-inbox-item'
import { sendBotMessage } from '@/lib/max/send-message'
import { fetchAttachmentAsBase64 } from '@/lib/max/fetch-attachment'
import { parseWeeklySubmission } from '@/lib/weekly/parser'
import { runSanityChecks, type SanityContext } from '@/lib/weekly/sanity-checks'
import { processWeeklySubmission } from '@/lib/weekly/actions'
import { notifyManagerAboutWeeklySubmission } from '@/lib/telegram/handlers/weekly-submission'
import type { ClientWithBotContext } from '@/lib/db/queries/bot'
import type { ParseResult } from '@/lib/weekly/parser'

/**
 * MEGA wiring (Subagent C): приём недельной заявки WEEKLY-клиента в MAX-вебхуке.
 * Фото бумажного списка или SMS-текст → parser → sanity → actions → notify.
 *
 * Готовые модули (parser/actions/sanity/notify) НЕ трогаем — только оркестрируем.
 */

const DAY_MS = 24 * 60 * 60 * 1000

// Дубль-гард (F1): на эту неделю уже есть заявка в ЛЮБОМ статусе, кроме
// CANCELLED → не запускаем LLM повторно. Раньше блокировали только
// [PARSED, AUTO_CONFIRMED]; из-за этого заявка в NEEDS_REVIEW/FAILED пропускала
// guard, парсер зря тратил LLM, а processWeeklySubmission падал на
// @@unique([clientId, weekStartDate]) (P2002) — клиент оставался без ответа.
// Теперь блокируем всё, кроме CANCELLED (после отмены клиент может прислать заново).
const DUP_NONBLOCKING_STATUSES = ['CANCELLED'] as const

// Существующий InboxItemReason (схему не меняем): для не-image вложений и
// дублей используем NON_NUMERIC, специфику кладём в humanReason.
const INBOX_REASON = 'NON_NUMERIC' as const

const REPLY_RECEIVED_AUTO = 'Получили заявку, передал менеджеру'
const REPLY_RECEIVED_PROCESSING = 'Получили, обрабатываем'
const REPLY_DUP = 'У нас уже есть ваша заявка на эту неделю. Менеджер проверит и свяжется с вами.'

/**
 * Ближайший БУДУЩИЙ понедельник по МСК-календарю, как UTC-полночь календарной
 * даты (тот же формат, что weekStartDate в схеме и что ждут parser/sanity/actions).
 *
 * «Будущий» строго: сегодня Пн → следующий Пн (через 7 дней); Ср → ближайший Пн;
 * Сб → ближайший Пн. Считаем от МСК-сегодня (getMskCalendarDayUtc), день недели
 * читаем из UTC-полночи (она же календарная дата).
 */
export function nextFutureMondayMsk(now: Date = new Date()): Date {
  const todayUtcMidnight = getMskCalendarDayUtc(now, 0)
  const dow = todayUtcMidnight.getUTCDay() // 0=Вс, 1=Пн, ... 6=Сб
  // Дней до следующего понедельника (строго в будущем): Пн→7, Вт→6, ..., Вс→1.
  const daysUntilMonday = ((1 - dow + 7) % 7) || 7
  return new Date(todayUtcMidnight.getTime() + daysUntilMonday * DAY_MS)
}

/** weekStartDate — UTC-полночь календарной даты МСК → строка «DD.MM.YYYY». */
function formatWeekStart(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${d.getUTCFullYear()}`
}

/**
 * Sanity-контекст из конфигурации клиента.
 *
 * expectedDaysPerWeek — из расписания активного WEEKLY-конфига
 *   (scheduleData.daysOfWeek.length), иначе дефолт 5 (рабочая неделя).
 * typicalPortionsPerDay — из config.fixedPortions, иначе среднее по недавним
 *   WEEKLY-заказам клиента (последние 8 недель), иначе дефолт 10.
 *
 * Числа лишь задают границы sanity-гейта (диапазоны порций / число дней) —
 * при провале заявка уходит на ручную проверку, не теряется.
 */
async function deriveSanityContext(
  clientId: string,
  weekStartDate: Date
): Promise<SanityContext> {
  const config = await prisma.clientMealConfig.findFirst({
    where: { clientId, orderType: 'WEEKLY', isActive: true },
    select: { scheduleData: true, fixedPortions: true },
  })

  let expectedDaysPerWeek = 5
  const schedule = config?.scheduleData as { daysOfWeek?: unknown } | null | undefined
  if (schedule && Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length > 0) {
    expectedDaysPerWeek = schedule.daysOfWeek.length
  }

  let typicalPortionsPerDay = 10
  if (config?.fixedPortions && config.fixedPortions > 0) {
    typicalPortionsPerDay = config.fixedPortions
  } else {
    const since = new Date(weekStartDate.getTime() - 8 * 7 * DAY_MS)
    const agg = await prisma.order.aggregate({
      where: {
        clientId,
        source: 'WEEKLY_AUTO',
        deliveryDate: { gte: since },
        status: { notIn: ['CANCELLED'] },
      },
      _avg: { portions: true },
    })
    const avg = agg._avg.portions
    if (avg && avg > 0) {
      typicalPortionsPerDay = Math.round(avg)
    }
  }

  return { expectedDaysPerWeek, typicalPortionsPerDay, weekStartDate }
}

/**
 * Дубль-гард: заявка на эту же неделю уже есть в живом статусе → InboxItem,
 * вежливый ответ клиенту, НЕ запускаем парсер. Возвращает true если это дубль.
 */
async function handleDuplicateGuard(
  client: ClientWithBotContext,
  weekStartDate: Date
): Promise<boolean> {
  const existing = await prisma.weeklyOrderSubmission.findFirst({
    where: {
      clientId: client.id,
      weekStartDate,
      status: { notIn: [...DUP_NONBLOCKING_STATUSES] },
    },
    select: { id: true, status: true },
  })
  if (!existing) return false

  await createInboxItem({
    clientId: client.id,
    reason: INBOX_REASON,
    humanReason: `Дубль заявки на неделю ${formatWeekStart(weekStartDate)}. Уже есть submission #${existing.id} в статусе ${existing.status}.`,
    priority: 'NORMAL',
  })
  if (client.maxChatId) {
    await sendBotMessage(client.maxChatId, REPLY_DUP)
  }
  return true
}

/**
 * Общий хвост: sanity → process → notify → ответ клиенту.
 */
async function finalizeSubmission(params: {
  client: ClientWithBotContext
  weekStartDate: Date
  source: 'PHOTO' | 'TEXT'
  blobUrl?: string
  rawText: string | null
  parsed: ParseResult
}): Promise<void> {
  const { client, weekStartDate, source, blobUrl, rawText, parsed } = params

  const sanityContext = await deriveSanityContext(client.id, weekStartDate)
  const sanityResult = runSanityChecks(parsed, sanityContext)

  const result = await processWeeklySubmission({
    clientId: client.id,
    source,
    blobUrl,
    rawText: rawText ?? undefined,
    parsedResult: parsed,
    sanityResult,
    weekStartDate,
  })

  // notifyManager ждёт статус AUTO_CONFIRMED | NEEDS_REVIEW. Всё остальное
  // (FAILED и т.п.) к менеджеру шлём как NEEDS_REVIEW — заявку надо разобрать руками.
  const notifyStatus = result.status === 'AUTO_CONFIRMED' ? 'AUTO_CONFIRMED' : 'NEEDS_REVIEW'
  await notifyManagerAboutWeeklySubmission({
    submissionId: result.submissionId,
    status: notifyStatus,
    clientName: client.name,
    items: parsed.items,
    dietaryNotes: parsed.dietaryNotes,
    confidence: parsed.confidence,
    reason: parsed.reason,
    source,
    blobUrl,
    rawText: rawText ?? undefined,
  })

  if (client.maxChatId) {
    const reply =
      result.status === 'AUTO_CONFIRMED' ? REPLY_RECEIVED_AUTO : REPLY_RECEIVED_PROCESSING
    await sendBotMessage(client.maxChatId, reply)
  }
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
  const { client, attachmentUrl, caption } = params
  const weekStartDate = nextFutureMondayMsk()

  if (await handleDuplicateGuard(client, weekStartDate)) return

  const { base64, buffer, mediaType } = await fetchAttachmentAsBase64(attachmentUrl)

  // Оригинальные байты (Buffer), не base64-строку — как в invoice-blob route.
  const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg'
  const pathname = `weekly-submissions/${client.id}/${Date.now()}.${ext}`
  const blob = await put(pathname, buffer, { access: 'public', contentType: mediaType })

  const parsed = await parseWeeklySubmission(
    { type: 'photo', base64, mediaType },
    { weekStartDate, clientName: client.name }
  )

  await finalizeSubmission({
    client,
    weekStartDate,
    source: 'PHOTO',
    blobUrl: blob.url,
    rawText: caption ?? null,
    parsed,
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
  const { client, text } = params
  const weekStartDate = nextFutureMondayMsk()

  if (await handleDuplicateGuard(client, weekStartDate)) return

  const parsed = await parseWeeklySubmission(
    { type: 'text', text },
    { weekStartDate, clientName: client.name }
  )

  await finalizeSubmission({
    client,
    weekStartDate,
    source: 'TEXT',
    rawText: text,
    parsed,
  })
}
