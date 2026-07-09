/**
 * READ-ONLY ФОРЕНЗИКА карантина на тике 08.07 (первый тик после фикса 02224f6).
 *
 * СТРОГО ЧТЕНИЕ. Никаких keywordbids.set / campaigns.update / suspend / записей в
 * БД / миграций. Только *.get, /stat/v1/data (poll отчётов) и SELECT из БД.
 * Токены не печатаем.
 *
 * Запуск: dotenv -e .env.local -- tsx scripts/boris-quarantine-forensic-0807.ts
 */

import { prisma } from '../src/lib/db/prisma'
import { getCampaignSettings } from '../src/lib/boris-direct/direct-client'
import {
  buildCampaignPerformanceReportBody,
  pollReport,
  parseReportTsv,
} from '../src/lib/boris-direct/reports'
import { decideQuarantine, campaignAgeDays, isInQuarantine } from '../src/lib/boris-direct/rules'
import { QUARANTINE_DAYS, QUARANTINE_MIN_CLICKS, DIRECT_CAMPAIGN_ID } from '../src/lib/boris-direct/config'

const YESTERDAY = '2026-07-07' // на тике 08.07 DateTo кумулятива = вчера = 07.07
const TODAY_MSK = '2026-07-08'

function tsvNum(raw: string | undefined): number {
  if (!raw || raw === '--') return 0
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

async function readReportsCumulative(startDate: string, dateTo: string) {
  const reportName = `bd_forensic_${startDate.replace(/-/g, '')}_${dateTo.replace(/-/g, '')}`
  const body = buildCampaignPerformanceReportBody(startDate, dateTo, reportName)
  for (let attempt = 1; attempt <= 6; attempt++) {
    const poll = await pollReport(body)
    if (poll.status === 'ready') {
      const rows = parseReportTsv(poll.tsv)
      const clicks = rows.reduce((acc, r) => acc + tsvNum(r.Clicks), 0)
      return { ok: true as const, rows: rows.length, clicks, tsvHead: poll.tsv.split('\n').slice(0, 3) }
    }
    if (poll.status === 'failed') return { ok: false as const, reason: `failed: ${poll.error}` }
    await new Promise((r) => setTimeout(r, Math.min(poll.retryInSec ?? 2, 8) * 1000))
  }
  return { ok: false as const, reason: 'всё ещё pending после лимита' }
}

async function main() {
  console.log('=== READ-ONLY ФОРЕНЗИКА КАРАНТИНА 08.07 (кампания ' + DIRECT_CAMPAIGN_ID + ') ===')
  console.log(`Пороги: QUARANTINE_DAYS=${QUARANTINE_DAYS}, QUARANTINE_MIN_CLICKS=${QUARANTINE_MIN_CLICKS}`)

  // ---------- ШАГ 2: независимое чтение СЫРОГО кабинета ----------
  console.log('\n--- ШАГ 2: сырой кабинет (не доверяя расчёту Бориса) ---')
  let startDate: string | null = null
  try {
    const s = await getCampaignSettings()
    startDate = s.StartDate ?? null
    console.log(`campaigns.get → StartDate = ${startDate}`)
    console.log(`campaigns.get → Statistics.Clicks (справочно, НЕ кумулятив периода) =`, s.Statistics?.Clicks ?? '(нет)')
  } catch (e) {
    console.log('[STOP] campaigns.get упал:', e instanceof Error ? e.message : String(e))
    return
  }

  if (!startDate) {
    console.log('[STOP] StartDate из кабинета пуст — дальше не идём (fail-safe удержал бы карантин).')
    return
  }

  const rep = await readReportsCumulative(startDate, YESTERDAY)
  if (!rep.ok) {
    console.log(`[STOP] Reports кумулятив ${startDate}→${YESTERDAY} не получен: ${rep.reason}`)
    return
  }
  console.log(`Reports CUSTOM_DATE ${startDate}→${YESTERDAY}: строк=${rep.rows}, СУММА Clicks=${rep.clicks}`)

  // ---------- ШАГ 1 (пересчёт): что вернул бы гейт на живых входах ----------
  console.log('\n--- ШАГ 1 (пересчёт гейта на живых входах) ---')
  const decided = decideQuarantine({ startDate, todayMsk: TODAY_MSK, cumulativeClicks: rep.clicks })
  const age = campaignAgeDays(startDate, TODAY_MSK)
  console.log(`campaignAgeDays(${startDate} → ${TODAY_MSK}) = ${age}`)
  console.log(`isInQuarantine({daysOfData:${age}, totalClicks:${rep.clicks}}) =`,
    isInQuarantine({ daysOfData: age, totalClicks: rep.clicks }))
  console.log('decideQuarantine →', JSON.stringify(decided))
  const branch = decided.factors.note ? `FAIL-SAFE (${decided.factors.note})` : 'нормальный расчёт'
  console.log(`ветвь: ${branch}`)

  // ---------- ШАГ 1 (runtime-факт из персиста БД) ----------
  console.log('\n--- ШАГ 1 (runtime-факт: персист тика в БД) ---')
  try {
    const daily = await prisma.borisDirectSnapshot.findMany({
      where: { kind: 'daily_result' },
      orderBy: [{ tickDate: 'desc' }, { createdAt: 'desc' }],
      take: 4,
    })
    if (daily.length === 0) {
      console.log('daily_result снапшотов НЕТ в этой БД (возможно, локальный DATABASE_URL ≠ прод).')
    }
    for (const d of daily) {
      const p = d.payload as Record<string, unknown>
      console.log(
        `daily_result tickDate=${d.tickDate.toISOString().slice(0, 10)} createdAt=${d.createdAt.toISOString()} ` +
        `dateLabel=${p.dateLabel} quarantine=${p.quarantine} clicks=${p.clicks} leadsTotal=${p.leadsTotal}`
      )
    }
    // StartDate-снапшот, на который опёрся бы тик (latest campaign_settings)
    const settingsSnap = await prisma.borisDirectSnapshot.findFirst({
      where: { kind: 'campaign_settings' },
      orderBy: [{ tickDate: 'desc' }, { createdAt: 'desc' }],
    })
    if (settingsSnap) {
      const sp = settingsSnap.payload as Record<string, unknown>
      console.log(`latest campaign_settings снапшот: tickDate=${settingsSnap.tickDate.toISOString().slice(0,10)} StartDate=${sp.StartDate}`)
    } else {
      console.log('campaign_settings снапшота НЕТ в этой БД → на проде тик взял бы fail-safe (нет StartDate).')
    }
  } catch (e) {
    console.log('[DB] чтение персиста упало (возможно, дев-БД спит P1001):', e instanceof Error ? e.message : String(e))
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
