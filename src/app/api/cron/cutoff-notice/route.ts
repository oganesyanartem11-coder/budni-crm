import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { sendBotMessage } from '@/lib/max/send-message'
import { CUTOFF_NOTICE_TEXT } from '@/lib/bot/templates'
import {
  findSilentPendingConvsCreatedToday,
  alreadyRanToday,
  markRanToday,
} from '@/lib/bot/daily-summary'

export const dynamic = 'force-dynamic'

const CRON_LABEL = 'cutoff-notice' // 16:00 МСК

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  const expectedSecret = process.env.CRON_SECRET

  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  if (authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()

  if (await alreadyRanToday(CRON_LABEL, now)) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_today' })
  }

  // Берём те же молчащие PENDING-conv. После рассылки переводим в EXPIRED —
  // это финальный статус для безответных заявок (enum BotConversationStatus
  // содержит EXPIRED, см. schema.prisma). Так findSilentPendingConvsCreatedToday
  // больше их не подберёт даже при повторном дёргании cron'а.
  const convs = await findSilentPendingConvsCreatedToday(now)

  let sent = 0
  const errors: Array<{ clientName: string; reason: string }> = []

  for (const conv of convs) {
    try {
      if (!conv.client.maxChatId) {
        // Без maxChatId не можем отправить, но статус всё равно закрываем.
        await prisma.botConversation.update({
          where: { id: conv.id },
          data: { status: 'EXPIRED' },
        })
        continue
      }

      await sendBotMessage(conv.client.maxChatId, CUTOFF_NOTICE_TEXT, { delay: false })
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
