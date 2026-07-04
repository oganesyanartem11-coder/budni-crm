/**
 * РАЗБОР ПЕРВОГО ЖИВОГО ДНЯ Бориса-Директа. СТРОГО READ-ONLY.
 *
 * Ни одного write-метода. Кампанию 711897777 write'ами НЕ трогаем.
 * Токены берутся из env транспортом и НЕ печатаются (печатаем только структуру).
 *
 * Запуск: dotenv -e .env.local -- tsx scripts/boris-direct-firstday-recon.ts
 *
 * Покрывает: ШАГ 1 (фактический ADD_METRICA_TAG), ШАГ 2 (keywords.get 8000 —
 * с/без StatusClarification), ШАГ 3 (ставки >400 ₽ + сырой SQ-отчёт 2026-07-03).
 */

import { directCall, getKeywordBids, getAdGroups, DirectApiError } from '../src/lib/boris-direct/direct-client'
import { pollReport, buildSearchQueryReportBody, parseReportTsv } from '../src/lib/boris-direct/reports'
import { DIRECT_CAMPAIGN_ID, BID_CEILING_MICRO, MICRO } from '../src/lib/boris-direct/config'

const CID = DIRECT_CAMPAIGN_ID
const STAMP = Date.now()
const SQ_DATE = '2026-07-03'
const TARGET_PHRASE = 'корпоративное питание с доставкой москва'

function section(t: string): void {
  console.log('\n\n========== ' + t + ' ==========')
}

async function step1(): Promise<void> {
  section('ШАГ 1 — campaigns.get: фактический ADD_METRICA_TAG')
  try {
    const r = await directCall<{ Campaigns?: Array<Record<string, unknown>> }>('campaigns', 'get', {
      SelectionCriteria: { Ids: [CID] },
      FieldNames: ['Id', 'Name', 'Type', 'State', 'Status'],
      TextCampaignFieldNames: ['Settings', 'CounterIds', 'BiddingStrategy'],
    })
    const c = r?.Campaigns?.[0]
    const tc = (c?.TextCampaign ?? null) as Record<string, unknown> | null
    const settings = (tc?.Settings ?? []) as Array<{ Option: string; Value: string }>
    console.log('Campaign Type:', c?.Type, '| State:', c?.State, '| Status:', c?.Status)
    console.log('TextCampaign present:', !!tc)
    console.log('CounterIds:', JSON.stringify(tc?.CounterIds ?? null))
    console.log('ВСЕ Settings ({Option,Value}):')
    console.log(JSON.stringify(settings, null, 2))
    const tag = settings.find((s) => s.Option === 'ADD_METRICA_TAG')
    console.log('\n>>> ADD_METRICA_TAG запись:', JSON.stringify(tag ?? '(ОТСУТСТВУЕТ в Settings)'))
    console.log('>>> Значение:', tag ? tag.Value : '(нет записи → getAddMetricaTagValue вернёт NO)')
  } catch (e) {
    console.log('[ERR step1]', e instanceof Error ? e.message : String(e))
  }
}

async function step2(): Promise<void> {
  section('ШАГ 2 — keywords.get: воспроизведение 8000 (с/без StatusClarification)')

  // 2a — ТЕКУЩИЙ боевой набор FieldNames (как в getKeywordsRaw).
  console.log('\n[2a] FieldNames = Id,Keyword,AdGroupId,State,Status,StatusClarification,Bid')
  try {
    const r = await directCall<{ Keywords?: unknown[] }>('keywords', 'get', {
      SelectionCriteria: { CampaignIds: [CID] },
      FieldNames: ['Id', 'Keyword', 'AdGroupId', 'State', 'Status', 'StatusClarification', 'Bid'],
      Page: { Limit: 5, Offset: 0 },
    })
    console.log('[2a] НЕОЖИДАННО OK, получено:', r?.Keywords?.length)
  } catch (e) {
    if (e instanceof DirectApiError) {
      console.log(`[2a] DirectApiError code=${e.code}`)
      console.log(`[2a] detail (перечень валидных полей): ${e.detail ?? '(нет detail)'}`)
    }
    console.log('[2a] message:', e instanceof Error ? e.message : String(e))
  }

  // 2b — БЕЗ StatusClarification (гипотеза фикса).
  console.log('\n[2b] FieldNames = Id,Keyword,AdGroupId,State,Status,Bid (без StatusClarification)')
  try {
    const r = await directCall<{ Keywords?: unknown[] }>('keywords', 'get', {
      SelectionCriteria: { CampaignIds: [CID] },
      FieldNames: ['Id', 'Keyword', 'AdGroupId', 'State', 'Status', 'Bid'],
      Page: { Limit: 5, Offset: 0 },
    })
    console.log('[2b] OK, получено (sample до 5):', r?.Keywords?.length)
  } catch (e) {
    console.log('[2b] message:', e instanceof Error ? e.message : String(e))
  }

  // 2c — ServingStatus вместо StatusClarification (кандидат-замена, если нужна причина простоя).
  console.log('\n[2c] проверка ServingStatus как валидного поля keywords.get')
  try {
    const r = await directCall<{ Keywords?: unknown[] }>('keywords', 'get', {
      SelectionCriteria: { CampaignIds: [CID] },
      FieldNames: ['Id', 'Keyword', 'ServingStatus'],
      Page: { Limit: 3, Offset: 0 },
    })
    console.log('[2c] ServingStatus OK, sample:', JSON.stringify(r?.Keywords?.slice(0, 3)))
  } catch (e) {
    console.log('[2c] ServingStatus message:', e instanceof Error ? e.message : String(e))
  }
}

async function step3a(): Promise<void> {
  section('ШАГ 3a — keywordbids.get: ставки > 400 ₽ (> 400000000 микро)')
  try {
    const bids = await getKeywordBids()
    // Карта KeywordId→текст и AdGroupId→имя (keywords.get БЕЗ StatusClarification, adgroups.get).
    const kwMap = new Map<number, string>()
    let offset = 0
    for (;;) {
      const r = await directCall<{ Keywords?: Array<{ Id: number; Keyword: string }>; LimitedBy?: number }>(
        'keywords', 'get', {
          SelectionCriteria: { CampaignIds: [CID] },
          FieldNames: ['Id', 'Keyword'],
          Page: { Limit: 10000, Offset: offset },
        }
      )
      for (const k of r?.Keywords ?? []) kwMap.set(k.Id, k.Keyword)
      if (r?.LimitedBy == null) break
      offset = r.LimitedBy
    }
    const groups = await getAdGroups()
    const grpMap = new Map<number, string>(groups.map((g) => [g.Id, g.Name]))

    const over = bids
      .filter((b) => (b.Search?.Bid ?? 0) > BID_CEILING_MICRO)
      .sort((a, b) => (b.Search?.Bid ?? 0) - (a.Search?.Bid ?? 0))
    console.log(`Всего ставок (keywordbids): ${bids.length}`)
    console.log(`Ставок > 400 ₽: ${over.length}`)
    for (const b of over) {
      const rub = (b.Search?.Bid ?? 0) / MICRO
      console.log(`   ${rub.toFixed(2)} ₽ | группа «${grpMap.get(b.AdGroupId) ?? b.AdGroupId}» | «${kwMap.get(b.KeywordId) ?? ('id ' + b.KeywordId)}»`)
    }
    // Заодно — максимум по всей кампании (контекст).
    const maxBid = bids.reduce((m, b) => Math.max(m, b.Search?.Bid ?? 0), 0)
    console.log(`Максимальная поисковая ставка по кампании: ${(maxBid / MICRO).toFixed(2)} ₽`)
  } catch (e) {
    console.log('[ERR step3a]', e instanceof Error ? e.message : String(e))
  }
}

async function step3b(): Promise<void> {
  section(`ШАГ 3b — сырой SQ-отчёт за ${SQ_DATE}: строка «${TARGET_PHRASE}»`)
  const body = buildSearchQueryReportBody(SQ_DATE, SQ_DATE, `bd_sq_${SQ_DATE.replace(/-/g, '')}_${STAMP}`)
  let tsv: string | null = null
  for (let attempt = 0; attempt < 12; attempt++) {
    const poll = await pollReport(body)
    if (poll.status === 'ready') {
      tsv = poll.tsv
      break
    }
    if (poll.status === 'failed') {
      console.log('[SQ report FAILED]', poll.error)
      return
    }
    console.log(`   отчёт готовится, попытка ${attempt + 1}, ждём ${Math.min(poll.retryInSec, 8)}с…`)
    await new Promise((r) => setTimeout(r, Math.min(poll.retryInSec, 8) * 1000))
  }
  if (tsv == null) {
    console.log('[SQ report] не дозрел за отведённые попытки')
    return
  }

  const rawLines = tsv.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l.trim().length > 0)
  console.log(`Строк в TSV (вкл. заголовок): ${rawLines.length}`)
  console.log(`Заголовок колонок: ${JSON.stringify(rawLines[0]?.split('\t'))}`)

  const rows = parseReportTsv(tsv)
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const targetNorm = norm(TARGET_PHRASE)

  // Все строки, где встречается «корпоративн…» + «москв…» (ловим целевую и соседей).
  const near = rows.filter((r) => {
    const q = norm(r.Query ?? '')
    return q.includes('корпоратив') && q.includes('москв')
  })
  console.log(`\nСтрок c «корпоратив…»+«москв…»: ${near.length}`)
  for (const r of near) {
    console.log(
      `   Query=«${r.Query}» | Group=${r.AdGroupName}(${r.AdGroupId}) | Impr=${r.Impressions} | Clicks=${r.Clicks} | Cost=${r.Cost} | Conv=${r.Conversions}`
    )
  }

  // Точная целевая строка(и) + СЫРАЯ tsv-строка (проверка склейки колонок парсером).
  console.log(`\nТочное совпадение «${TARGET_PHRASE}» — сырые TSV-строки:`)
  const cols = rawLines[0].split('\t')
  const qIdx = cols.indexOf('Query')
  let hits = 0
  for (const raw of rawLines.slice(1)) {
    const cells = raw.split('\t')
    if (norm(cells[qIdx] ?? '') === targetNorm) {
      hits++
      console.log(`   raw(${cells.length} колонок): ${JSON.stringify(raw)}`)
      console.log(`   cells: ${JSON.stringify(cells)}`)
    }
  }
  if (hits === 0) console.log('   (точного совпадения не найдено — фраза могла склеиться/отличаться; см. соседей выше)')

  // Сумма по всем строкам целевой фразы (если их несколько групп) — объяснить 1276 ₽/1 клик.
  const exact = rows.filter((r) => norm(r.Query ?? '') === targetNorm)
  if (exact.length > 0) {
    const num = (s: string) => (s === '--' || !s ? 0 : Number(s.replace(',', '.')) || 0)
    const sumCost = exact.reduce((a, r) => a + num(r.Cost), 0)
    const sumClicks = exact.reduce((a, r) => a + num(r.Clicks), 0)
    const sumImpr = exact.reduce((a, r) => a + num(r.Impressions), 0)
    console.log(
      `\nАгрегат целевой фразы: строк=${exact.length}, Impr=${sumImpr}, Clicks=${sumClicks}, Cost=${sumCost} ₽ (вкл. НДС)`
    )
    if (sumClicks > 0) console.log(`Средняя цена клика: ${(sumCost / sumClicks).toFixed(2)} ₽/клик`)
  }
}

async function main(): Promise<void> {
  console.log(`Разбор первого живого дня. Кампания ${CID}. SQ-дата: ${SQ_DATE}. READ-ONLY.`)
  await step1()
  await step2()
  await step3a()
  await step3b()
  console.log('\n\n========== РАЗБОР ЗАВЕРШЁН (ни одного write) ==========')
}

main().catch((e) => {
  console.error('FATAL', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
