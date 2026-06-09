import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { sendBotMessage } from '@/lib/max/send-message'
import { CUTOFF_NOTICE_TEXT } from '@/lib/bot/templates'
import {
  findSilentPendingConvsCreatedToday,
  alreadyRanToday,
  markRanToday,
} from '@/lib/bot/daily-summary'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { getActiveMaxChatIdForClient } from '@/lib/bot/max-users'

export const dynamic = 'force-dynamic'

const CRON_LABEL = 'cutoff-notice' // 16:00 МСК

async function handler(_request: Request) {
  const now = new Date()

  if (await alreadyRanToday(CRON_LABEL, now)) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_today' })
  }

  // Берём те же молчащие PENDING-conv. После рассылки переводим в EXPIRED —
  // это финальный статус для безответных заявок (enum BotConversationStatus
  // содержит EXPIRED, см. schema.prisma). Так findSilentPendingConvsCreatedToday
  // больше их не подберёт даже при повторном дёргании cron'а.
  const convs = await findSilentPendingConvsCreatedToday(now)

  // sameDay-клиентов глобальный 16:00 notice НЕ трогает: у них утренний cut-off,
  // закрытие приёма для них происходит отдельно (SAMEDAY_ORDER_LOCKED). Делаем
  // отдельный лёгкий запрос по clientId вместо правки shared-функции
  // findSilentPendingConvsCreatedToday (её же использует reminder-1/2).
  const clientIds = [...new Set(convs.map((c) => c.clientId))]
  const sameDayClients = clientIds.length
    ? await prisma.client.findMany({
        where: { id: { in: clientIds }, locations: { some: { sameDayDelivery: true } } },
        select: { id: true },
      })
    : []
  const sameDayClientIds = new Set(sameDayClients.map((c) => c.id))

  let sent = 0
  const errors: Array<{ clientName: string; reason: string }> = []

  for (const conv of convs) {
    if (sameDayClientIds.has(conv.clientId)) {
      // sameDay — пропускаем без смены статуса (их закрывает свой механизм).
      continue
    }
    try {
      const chatId = await getActiveMaxChatIdForClient(conv.clientId)
      if (!chatId) {
        // Без активного chatId не можем отправить, но статус всё равно закрываем.
        await prisma.botConversation.update({
          where: { id: conv.id },
          data: { status: 'EXPIRED' },
        })
        continue
      }

      await sendBotMessage(chatId, CUTOFF_NOTICE_TEXT, { delay: false })
      await prisma.botMessage.create({
        data: {
          clientId: conv.clientId,
          conversationId: conv.id,
          direction: 'OUT',
          text: CUTOFF_NOTICE_TEXT,
        },
      })
      await prisma.botConversation.update({
        where: { id: conv.id },
        data: { status: 'EXPIRED' },
      })
      sent++
    } catch (err) {
      errors.push({
        clientName: conv.client.name,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  await markRanToday(CRON_LABEL, { sent_notices: sent, errors: errors.length })

  return NextResponse.json({ ok: true, sent_notices: sent, errors })
}

export const GET = withCronHeartbeat('cutoff-notice', handler)
