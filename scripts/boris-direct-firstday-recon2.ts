/**
 * РАЗБОР ПЕРВОГО ЖИВОГО ДНЯ — добор по ШАГ 3b (причина 1276 ₽/1 клик). READ-ONLY.
 *
 * Печатаем BiddingStrategy кампании (есть ли per-click потолок) + проверенный
 * отчёт эффективности по группам за 2026-07-03 (Cost/Clicks/AvgCpc по G2).
 * Токены из env, не печатаются. Ни одного write-метода.
 *
 * Запуск: dotenv -e .env.local -- tsx scripts/boris-direct-firstday-recon2.ts
 */

import { directCall } from '../src/lib/boris-direct/direct-client'
import { pollReport, buildCampaignPerformanceReportBody } from '../src/lib/boris-direct/reports'
import { DIRECT_CAMPAIGN_ID } from '../src/lib/boris-direct/config'

const CID = DIRECT_CAMPAIGN_ID
const STAMP = Date.now()
const DATE = '2026-07-03'

async function biddingStrategy(): Promise<void> {
  console.log('\n========== BiddingStrategy кампании ==========')
  try {
    const r = await directCall<{ Campaigns?: Array<Record<string, unknown>> }>('campaigns', 'get', {
      SelectionCriteria: { Ids: [CID] },
      FieldNames: ['Id', 'Name'],
      TextCampaignFieldNames: ['BiddingStrategy'],
    })
    const c = r?.Campaigns?.[0]
    const tc = (c?.TextCampaign ?? {}) as Record<string, unknown>
    console.log(JSON.stringify(tc.BiddingStrategy ?? '(нет BiddingStrategy)', null, 2))
  } catch (e) {
    console.log('[ERR biddingStrategy]', e instanceof Error ? e.message : String(e))
  }
}

async function perfReport(): Promise<void> {
  console.log(`\n========== Отчёт эффективности по группам за ${DATE} ==========`)
  const body = buildCampaignPerformanceReportBody(DATE, DATE, `bd_perf_${DATE.replace(/-/g, '')}_${STAMP}`)
  for (let attempt = 0; attempt < 12; attempt++) {
    const poll = await pollReport(body)
    if (poll.status === 'ready') {
      console.log('TSV:')
      console.log(poll.tsv.trim() || '(пусто)')
      return
    }
    if (poll.status === 'failed') {
      console.log('[perf report FAILED]', poll.error)
      return
    }
    console.log(`   готовится, попытка ${attempt + 1}, ждём ${Math.min(poll.retryInSec, 8)}с…`)
    await new Promise((r) => setTimeout(r, Math.min(poll.retryInSec, 8) * 1000))
  }
  console.log('[perf report] не дозрел')
}

async function main(): Promise<void> {
  console.log(`Добор ШАГ 3b. Кампания ${CID}. Дата ${DATE}. READ-ONLY.`)
  await biddingStrategy()
  await perfReport()
  console.log('\n========== ДОБОР ЗАВЕРШЁН ==========')
}

main().catch((e) => {
  console.error('FATAL', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
