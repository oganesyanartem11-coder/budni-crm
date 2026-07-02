/**
 * Cron: Борис-Директ, тик «сбор» (утро, расписание в vercel.json задаёт
 * оркестратор).
 *
 * Логика:
 * 1. Идемпотентность на сутки (alreadyRanToday/markRanToday), ?force=true — обход.
 * 2. runCollectTick: снапшоты состояния + заказ отчётов за вчера + аномалии.
 * 3. Аномалии — владельцу НЕМЕДЛЕННО (не ждут дневного отчёта).
 * 4. Катастрофа расхода → аварийная остановка кампании + срочное сообщение.
 */

import { NextResponse } from 'next/server'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { runCollectTick } from '@/lib/boris-direct/brain'
import { suspendCampaignEmergency } from '@/lib/boris-direct/write-gate'
import { sendToDirectChat } from '@/lib/boris-direct/telegram'
import { formatAnomalyMessage } from '@/lib/boris-direct/report-texts'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_LABEL = 'boris-direct-collect'

async function handler(request: Request) {
  const force = new URL(request.url).searchParams.get('force') === 'true'

  if (!force && (await alreadyRanToday(JOB_LABEL))) {
    return NextResponse.json({ ok: true, skipped: 'already_ran' })
  }

  const result = await runCollectTick()

  // Аномалии шлём владельцу сразу — детерминированный формат, без LLM.
  for (const anomaly of result.anomalies) {
    await sendToDirectChat(formatAnomalyMessage(anomaly))
  }

  // Катастрофа (неуправляемый расход): аварийная остановка проходит даже
  // сквозь стоп-кран (emergency), но не сквозь OBSERVE — write-gate решит.
  if (result.catastrophe) {
    await suspendCampaignEmergency('катастрофа: неуправляемый расход')
    await sendToDirectChat(
      '🚨 <b>КАТАСТРОФА</b>: неуправляемый расход — аварийно останавливаю кампанию. ' +
        'Разберись с причиной, включение обратно — за тобой.'
    )
  }

  await markRanToday(JOB_LABEL, {
    anomalies: result.anomalies.length,
    requestedReports: result.requestedReports,
    catastrophe: result.catastrophe,
  })

  return NextResponse.json({
    ok: true,
    anomalies: result.anomalies.length,
    requestedReports: result.requestedReports,
  })
}

export const GET = withCronHeartbeat(JOB_LABEL, handler)
