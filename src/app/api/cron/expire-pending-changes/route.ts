import { NextResponse } from 'next/server'
import { sendBotMessage } from '@/lib/max/send-message'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { expirePendingChanges } from '@/lib/order-changes/actions'

export const dynamic = 'force-dynamic'

/**
 * MEGA-4b (П3): каждые 10 мин помечает протухшие (>30 мин) PENDING-запросы
 * клиентов как EXPIRED и шлёт клиентам автоответ в MAX, что не успели
 * обработать. Идемпотентность/гонку с ручным confirm/reject закрывает
 * атомарный claim status='PENDING' внутри expirePendingChanges.
 *
 * Auth + heartbeat — withCronHeartbeat (handler свой auth не делает).
 */
export async function handler(_request: Request) {
  const result = await expirePendingChanges()

  let sent = 0
  let failed = 0
  for (const { clientMaxChatId, postCutoffReplyText } of result.expired) {
    try {
      // delay:false — cron-рассылка, без «живой» задержки.
      await sendBotMessage(clientMaxChatId, postCutoffReplyText, { delay: false })
      sent++
    } catch (e) {
      failed++
      console.error('[expire-pending-changes] send failed', e)
    }
  }

  return NextResponse.json({ ok: true, expired: result.expired.length, sent, failed })
}

export const GET = withCronHeartbeat('expire-pending-changes', handler)
