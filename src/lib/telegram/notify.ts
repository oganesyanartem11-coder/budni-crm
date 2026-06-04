import type { InlineKeyboard } from 'grammy'
import { prisma } from '@/lib/db/prisma'
import { sendTelegramMessage } from './send'
import { getTelegramEnv, readProductionChatId } from './env'

export interface NotifyOptions {
  /** Если не указан — текст шлётся без parseMode (как plain text). */
  parseMode?: 'HTML' | 'MarkdownV2'
  replyMarkup?: InlineKeyboard
}

const DEFAULT_PARSE_MODE: 'HTML' = 'HTML'

export interface NotifyManagerDirectResult {
  ok: boolean
  skipped?: boolean
  error?: string
}

/**
 * Пуш конкретному менеджеру в личку Telegram.
 *
 * Если у юзера нет telegramChatId или он неактивен — НЕ шлёт ничего и
 * возвращает skipped:true. В MAX мы не уходим (управленческий канал
 * полностью Telegram, см. 5.8c).
 */
export async function notifyManagerDirect(
  userId: string,
  text: string,
  opts?: NotifyOptions
): Promise<NotifyManagerDirectResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, telegramChatId: true, isActive: true },
  })

  if (!user) {
    console.log(`[telegram/notify] skipped: user not found id=${userId}`)
    return { ok: false, skipped: true, error: 'user_not_found' }
  }
  if (!user.isActive) {
    console.log(`[telegram/notify] skipped: user inactive id=${userId} (${user.name})`)
    return { ok: false, skipped: true, error: 'user_inactive' }
  }
  if (!user.telegramChatId) {
    console.log(`[telegram/notify] skipped: no telegram chatId for user ${userId} (${user.name})`)
    return { ok: false, skipped: true, error: 'no_telegram_chat_id' }
  }

  const result = await sendTelegramMessage(user.telegramChatId, text, {
    parseMode: opts?.parseMode ?? DEFAULT_PARSE_MODE,
    replyMarkup: opts?.replyMarkup,
  })
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  return { ok: true }
}

export interface NotifyAllManagersResult {
  sentTo: number
  skippedNoTelegram: number
  failed: number
}

/**
 * Пуш всем активным ADMIN/MANAGER c привязанным Telegram.
 *
 * skippedNoTelegram = active ADMIN+MANAGER без telegramChatId (нужно онбординг).
 * failed = ошибка от Telegram API при отправке (forbidden/chat_not_found/etc).
 *
 * Не кидает. Параллельная отправка через Promise.allSettled.
 */
export async function notifyAllManagersDirect(
  text: string,
  opts?: NotifyOptions
): Promise<NotifyAllManagersResult> {
  const allManagers = await prisma.user.findMany({
    where: { isActive: true, role: { in: ['ADMIN', 'ADMIN_PRO', 'MANAGER'] } },
    select: { id: true, telegramChatId: true },
  })

  const withTelegram = allManagers.filter((m) => m.telegramChatId !== null)
  const skippedNoTelegram = allManagers.length - withTelegram.length

  if (withTelegram.length === 0) {
    console.warn(
      `[telegram/notify] notifyAllManagers: no managers with telegramChatId ` +
        `(total active managers: ${allManagers.length})`
    )
    return { sentTo: 0, skippedNoTelegram, failed: 0 }
  }

  const sends = await Promise.allSettled(
    withTelegram.map((m) =>
      sendTelegramMessage(m.telegramChatId as string, text, {
        parseMode: opts?.parseMode ?? DEFAULT_PARSE_MODE,
        replyMarkup: opts?.replyMarkup,
      })
    )
  )

  let sentTo = 0
  let failed = 0
  for (const s of sends) {
    if (s.status === 'fulfilled' && s.value.ok) sentTo++
    else failed++
  }

  console.log(
    `[telegram/notify] notifyAllManagers: sentTo=${sentTo} skippedNoTelegram=${skippedNoTelegram} failed=${failed}`
  )

  return { sentTo, skippedNoTelegram, failed }
}

/**
 * Пуш всем активным ADMIN_PRO c привязанным Telegram.
 *
 * Используется для HIGH-алёртов приёмки накладных (7.14A): даже если
 * групповой чат пропущен, ADMIN_PRO получит личный пуш.
 */
export async function notifyAllAdminProDirect(
  text: string,
  opts?: NotifyOptions
): Promise<NotifyAllManagersResult> {
  const allAdminPro = await prisma.user.findMany({
    where: { isActive: true, role: 'ADMIN_PRO' },
    select: { id: true, telegramChatId: true },
  })

  const withTelegram = allAdminPro.filter((m) => m.telegramChatId !== null)
  const skippedNoTelegram = allAdminPro.length - withTelegram.length

  if (withTelegram.length === 0) {
    console.warn(
      `[telegram/notify] notifyAllAdminPro: no ADMIN_PRO with telegramChatId ` +
        `(total active ADMIN_PRO: ${allAdminPro.length})`
    )
    return { sentTo: 0, skippedNoTelegram, failed: 0 }
  }

  const sends = await Promise.allSettled(
    withTelegram.map((m) =>
      sendTelegramMessage(m.telegramChatId as string, text, {
        parseMode: opts?.parseMode ?? DEFAULT_PARSE_MODE,
        replyMarkup: opts?.replyMarkup,
      })
    )
  )

  let sentTo = 0
  let failed = 0
  for (const s of sends) {
    if (s.status === 'fulfilled' && s.value.ok) sentTo++
    else failed++
  }

  console.log(
    `[telegram/notify] notifyAllAdminPro: sentTo=${sentTo} skippedNoTelegram=${skippedNoTelegram} failed=${failed}`
  )

  return { sentTo, skippedNoTelegram, failed }
}

/**
 * 7.15 hotfix #1: получатели tone-алёртов (rude/urgent).
 *
 * Список = все активные MANAGER ∪ все активные user c receivesToneAlerts=true.
 * Дедуп по userId на уровне SQL (OR в where → один user не попадёт дважды).
 * Покрывает кейс «алёрт должен видеть ADMIN_PRO», не размывая existing
 * notifyAllManagersDirect (тот используется для общих сводок ADMIN+MANAGER).
 *
 * Возвращаемый тип идентичен notifyAllManagersDirect — точка замены чистая.
 */
export async function notifyToneRecipients(
  text: string,
  opts?: NotifyOptions
): Promise<NotifyAllManagersResult> {
  const recipients = await prisma.user.findMany({
    where: {
      isActive: true,
      OR: [{ role: 'MANAGER' }, { receivesToneAlerts: true }],
    },
    select: { id: true, telegramChatId: true },
  })

  const withTelegram = recipients.filter((u) => u.telegramChatId !== null)
  const skippedNoTelegram = recipients.length - withTelegram.length

  if (withTelegram.length === 0) {
    console.warn(
      `[telegram/notify] notifyToneRecipients: no recipients with telegramChatId ` +
        `(total: ${recipients.length})`
    )
    return { sentTo: 0, skippedNoTelegram, failed: 0 }
  }

  const sends = await Promise.allSettled(
    withTelegram.map((u) =>
      sendTelegramMessage(u.telegramChatId as string, text, {
        parseMode: opts?.parseMode ?? DEFAULT_PARSE_MODE,
        replyMarkup: opts?.replyMarkup,
      })
    )
  )

  let sentTo = 0
  let failed = 0
  for (const s of sends) {
    if (s.status === 'fulfilled' && s.value.ok) sentTo++
    else failed++
  }

  console.log(
    `[telegram/notify] notifyToneRecipients: sentTo=${sentTo} skippedNoTelegram=${skippedNoTelegram} failed=${failed}`
  )

  return { sentTo, skippedNoTelegram, failed }
}

/**
 * 7.15.B: единый список получателей алёртов о клиентах (inbox + tone слиты).
 *
 * Список = все активные ADMIN/MANAGER/ADMIN_PRO ∪ User.receivesToneAlerts=true.
 * Семантически это «все получатели критичных клиентских алёртов» — широкий
 * охват по умолчанию + addressable через флаг для не-ролевых юзеров.
 *
 * Используется в notifyClientSignal (объединённый канал). Старые
 * notifyAllManagersDirect / notifyToneRecipients оставлены для backward
 * compat вызовов (digest, прочее).
 */
export async function notifyAlertRecipients(
  text: string,
  opts?: NotifyOptions
): Promise<NotifyAllManagersResult> {
  const recipients = await prisma.user.findMany({
    where: {
      isActive: true,
      OR: [
        { role: { in: ['ADMIN', 'MANAGER', 'ADMIN_PRO'] } },
        { receivesToneAlerts: true },
      ],
    },
    select: { id: true, telegramChatId: true },
  })

  const withTelegram = recipients.filter((u) => u.telegramChatId !== null)
  const skippedNoTelegram = recipients.length - withTelegram.length

  if (withTelegram.length === 0) {
    // MEGA-AUDIT-FIX-1 C3 (D-7): sentTo=0 — это потеря сигнала, а не ворнинг.
    // Поднимаем уровень до error с явным префиксом LOST_SIGNAL, чтобы было
    // легко фильтровать в логах Vercel.
    console.error(
      `[telegram/notify] LOST_SIGNAL notifyAlertRecipients: no recipients with telegramChatId ` +
        `(total: ${recipients.length})`
    )
    return { sentTo: 0, skippedNoTelegram, failed: 0 }
  }

  const sends = await Promise.allSettled(
    withTelegram.map((u) =>
      sendTelegramMessage(u.telegramChatId as string, text, {
        parseMode: opts?.parseMode ?? DEFAULT_PARSE_MODE,
        replyMarkup: opts?.replyMarkup,
      })
    )
  )

  let sentTo = 0
  let failed = 0
  for (const s of sends) {
    if (s.status === 'fulfilled' && s.value.ok) sentTo++
    else failed++
  }

  console.log(
    `[telegram/notify] notifyAlertRecipients: sentTo=${sentTo} skippedNoTelegram=${skippedNoTelegram} failed=${failed}`
  )

  return { sentTo, skippedNoTelegram, failed }
}

export interface NotifyGroupResult {
  ok: boolean
  error?: string
}

/**
 * Сообщение в групповой чат менеджеров.
 *
 * Бот должен быть админом группы (или хотя бы участником с правом писать).
 * Если 403 (бот кикнут / не админ) — sendTelegramMessage поймает и вернёт error.
 */
export async function notifyGroup(text: string, opts?: NotifyOptions): Promise<NotifyGroupResult> {
  const { groupChatId } = getTelegramEnv()
  const result = await sendTelegramMessage(groupChatId, text, {
    parseMode: opts?.parseMode ?? DEFAULT_PARSE_MODE,
    replyMarkup: opts?.replyMarkup,
  })
  if (!result.ok) {
    console.error(`[telegram/notify] notifyGroup failed: ${result.error}`)
    return { ok: false, error: result.error }
  }
  return { ok: true }
}

/**
 * П5: отправка в канал производства (TELEGRAM_PRODUCTION_CHAT_ID).
 *
 * Приоритет: если ENV задан и валиден — шлём туда. При любом провале
 * (ENV не задан / отправка вернула ok:false / sendTelegramMessage кинул) —
 * фолбэк в личку всем активным ADMIN_PRO, чтобы сводка не потерялась.
 *
 * sendTelegramMessage по контракту не кидает (возвращает {ok:false, error}),
 * поэтому основная проверка — result.ok. try/catch оставлен как страховка от
 * неожиданного throw (напр. отсутствие бот-токена в getTelegramBot).
 */
export async function notifyProductionChannel(text: string, opts?: NotifyOptions): Promise<void> {
  const productionChatId = readProductionChatId()
  if (productionChatId) {
    try {
      const result = await sendTelegramMessage(productionChatId, text, {
        parseMode: opts?.parseMode ?? DEFAULT_PARSE_MODE,
        replyMarkup: opts?.replyMarkup,
      })
      if (result.ok) return
      console.warn(
        `[notify-production] send to production chat failed (${result.error}), falling back to ADMIN_PRO direct`
      )
    } catch (error) {
      console.warn(
        '[notify-production] send to production chat threw, falling back to ADMIN_PRO direct',
        error
      )
    }
  }
  // ENV не задан / отправка упала → фолбэк в личку всем ADMIN_PRO.
  await notifyAllAdminProDirect(text, opts)
}

/**
 * HTML escape для интерполяции пользовательских строк (имена клиентов,
 * локаций) в сообщения с parseMode='HTML'. Без этого Telegram упадёт
 * на `<`, `>`, `&` в данных.
 *
 * Кавычки в plain-тексте экранировать не нужно — они уходят как есть.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
