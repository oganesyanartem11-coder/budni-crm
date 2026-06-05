import { prisma } from '@/lib/db/prisma'
import { readProductionChatId } from '@/lib/telegram/env'
import { sendTelegramDocument } from '@/lib/telegram/send-document'

export interface SendRouteSheetParams {
  pdfBuffer: Buffer
  filename: string
  caption: string
}

/**
 * П2: отправка маршрутного листа (PDF) в чат-производство.
 *
 * Приоритет — TELEGRAM_PRODUCTION_CHAT_ID (тот же ENV, что и
 * notifyProductionChannel в telegram/notify.ts). При любом провале (ENV не
 * задан / отправка вернула ok:false / sendTelegramDocument кинул, чего по
 * контракту не должно) — фолбэк: шлём файл в личку каждому активному ADMIN_PRO
 * с привязанным telegramChatId, чтобы лист не потерялся.
 *
 * Зеркалит фолбэк-логику notifyProductionChannel, но для документов.
 * Никогда не кидает.
 */
export async function sendRouteSheetToProduction(params: SendRouteSheetParams): Promise<void> {
  const { pdfBuffer, filename, caption } = params

  const productionChatId = readProductionChatId()
  if (productionChatId) {
    const result = await sendTelegramDocument({
      chatId: productionChatId,
      buffer: pdfBuffer,
      filename,
      caption,
    })
    if (result.ok) return
    console.warn(
      `[route-sheet/send] send to production chat failed (${result.error}), falling back to ADMIN_PRO direct`
    )
  }

  // ENV не задан / отправка упала → фолбэк в личку всем активным ADMIN_PRO.
  const adminPros = await prisma.user.findMany({
    where: { isActive: true, role: 'ADMIN_PRO' },
    select: { telegramChatId: true },
  })
  const recipients = adminPros.filter((u) => u.telegramChatId !== null)

  if (recipients.length === 0) {
    console.error(
      '[route-sheet/send] LOST_SIGNAL: no ADMIN_PRO with telegramChatId for route-sheet fallback'
    )
    return
  }

  const sends = await Promise.allSettled(
    recipients.map((u) =>
      sendTelegramDocument({
        chatId: u.telegramChatId as string,
        buffer: pdfBuffer,
        filename,
        caption,
      })
    )
  )

  let sentTo = 0
  let failed = 0
  for (const s of sends) {
    if (s.status === 'fulfilled' && s.value.ok) sentTo++
    else failed++
  }
  console.log(`[route-sheet/send] ADMIN_PRO fallback: sentTo=${sentTo} failed=${failed}`)
}
