/**
 * РАЗВЕДКА ЖИВОГО КАБИНЕТА (ШАГ 1 сессии «Прозрение Бориса»).
 *
 * СТРОГО READ-ONLY: только *.get и /stat/v1/data и poll отчётов. Ни одного
 * write-метода. Кампанию 711897777 не трогаем write'ами. Токены не печатаем
 * (транспорт их не логирует; здесь тоже — печатаем только структуру ответов).
 *
 * Запуск: dotenv -e .env.local -- tsx scripts/boris-direct-recon.ts
 */

import { directCall } from '../src/lib/boris-direct/direct-client'
import { metrikaStat } from '../src/lib/boris-direct/metrika-client'
import { pollReport } from '../src/lib/boris-direct/reports'
import { DIRECT_CAMPAIGN_ID, METRIKA_GOAL_ID } from '../src/lib/boris-direct/config'

const GOAL = `ym:s:goal${METRIKA_GOAL_ID}reaches`
const CID = DIRECT_CAMPAIGN_ID

function section(t: string): void {
  console.log('\n\n========== ' + t + ' ==========')
}
function show(label: string, v: unknown): void {
  console.log(`\n— ${label}:`)
  console.log(JSON.stringify(v, null, 2))
}
async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (e) {
    console.log(`\n[ERR ${label}] ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** YYYY-MM-DD по МСК, days назад от сейчас. */
function mskDaysAgo(days: number): string {
  const t = Date.now() + 3 * 3600_000 - days * 86400_000
  return new Date(t).toISOString().slice(0, 10)
}
const DATE_FROM = mskDaysAgo(30)
const DATE_TO = mskDaysAgo(1)

async function main(): Promise<void> {
  console.log(`Разведка кампании ${CID}. Период Метрики/отчётов: ${DATE_FROM} .. ${DATE_TO}`)

  // ---------- 1. campaigns.get — ПОЛНЫЙ набор полей ----------
  section('1. campaigns.get — полное состояние (TimeTargeting, NegativeKeywords, Settings…)')
  await safe('campaigns.get(full)', async () => {
    const r = await directCall<{ Campaigns?: unknown[] }>('campaigns', 'get', {
      SelectionCriteria: { Ids: [CID] },
      FieldNames: [
        'Id', 'Name', 'Type', 'State', 'Status', 'StatusPayment', 'StatusClarification',
        'SourceId', 'Currency', 'DailyBudget', 'StartDate', 'EndDate', 'Funds',
        'TimeTargeting', 'TimeZone', 'ContextLimit', 'NegativeKeywords',
        'BlockedIps', 'ExcludedSites', 'Statistics',
      ],
      TextCampaignFieldNames: [
        'BiddingStrategy', 'Settings', 'CounterIds', 'RelevantKeywords',
        'PriorityGoals', 'AttributionModel',
      ],
    })
    show('campaign', r?.Campaigns?.[0])
    return r
  })

  // ---------- 2. bidmodifiers.get — корректировки ставок ----------
  section('2. bidmodifiers.get — корректировки (устройства/демография/гео/аудитории/расписание)')
  const bm = await safe('bidmodifiers.get(full)', async () =>
    directCall<{ BidModifiers?: unknown[] }>('bidmodifiers', 'get', {
      SelectionCriteria: { CampaignIds: [CID] },
      FieldNames: ['Id', 'CampaignId', 'AdGroupId', 'Type', 'Level'],
      MobileAdjustmentFieldNames: ['BidModifier', 'OperatingSystemType'],
      DesktopAdjustmentFieldNames: ['BidModifier'],
      DemographicsAdjustmentFieldNames: ['Age', 'Gender', 'BidModifier'],
      RegionalAdjustmentFieldNames: ['RegionId', 'BidModifier'],
      RetargetingAdjustmentFieldNames: ['RetargetingConditionId', 'BidModifier'],
    })
  )
  if (bm) show('bidModifiers', bm.BidModifiers ?? [])
  else {
    // Фолбэк: только базовые поля (вдруг какой-то FieldNames-группы нет в этом типе кампании).
    await safe('bidmodifiers.get(base)', async () => {
      const r = await directCall<{ BidModifiers?: unknown[] }>('bidmodifiers', 'get', {
        SelectionCriteria: { CampaignIds: [CID] },
        FieldNames: ['Id', 'CampaignId', 'AdGroupId', 'Type', 'Level'],
      })
      show('bidModifiers(base)', r?.BidModifiers ?? [])
      return r
    })
  }

  // ---------- 3. adgroups.get — структура групп + групповые минус-фразы ----------
  section('3. adgroups.get — группы + NegativeKeywords уровня группы')
  await safe('adgroups.get', async () => {
    const r = await directCall<{ AdGroups?: unknown[] }>('adgroups', 'get', {
      SelectionCriteria: { CampaignIds: [CID] },
      FieldNames: ['Id', 'Name', 'CampaignId', 'Status', 'Type', 'NegativeKeywords', 'RegionIds', 'TrackingParams'],
    })
    show('adGroups', r?.AdGroups ?? [])
    return r
  })

  // ---------- 4. keywords.get — операторы соответствия в текстах ключей ----------
  section('4. keywords.get — операторы соответствия (кавычки/!/+)')
  await safe('keywords.get', async () => {
    const r = await directCall<{ Keywords?: Array<{ Keyword: string; AdGroupId: number; State: string }> }>(
      'keywords', 'get', {
        SelectionCriteria: { CampaignIds: [CID] },
        FieldNames: ['Id', 'Keyword', 'AdGroupId', 'State'],
        Page: { Limit: 10000, Offset: 0 },
      }
    )
    const kws = (r?.Keywords ?? []).filter((k) => k.Keyword !== '---autotargeting')
    const withQuotes = kws.filter((k) => k.Keyword.includes('"')).length
    const withBang = kws.filter((k) => k.Keyword.includes('!')).length
    const withPlus = kws.filter((k) => k.Keyword.includes('+')).length
    const withBracket = kws.filter((k) => k.Keyword.includes('[')).length
    console.log(`Всего ключей (без автотаргета): ${kws.length}`)
    console.log(`С кавычками "…": ${withQuotes} | с ! : ${withBang} | с + : ${withPlus} | с [порядок] : ${withBracket}`)
    console.log('Примеры ключей (до 20):')
    for (const k of kws.slice(0, 20)) console.log(`   [${k.AdGroupId}] ${k.State}  ${k.Keyword}`)
    return r
  })

  // ---------- 5. ads.get — расширения объявлений ----------
  section('5. ads.get — расширения (сайтлинки/уточнения/визитка/цены)')
  await safe('ads.get(extensions)', async () => {
    const r = await directCall<{ Ads?: Array<Record<string, unknown>> }>('ads', 'get', {
      SelectionCriteria: { CampaignIds: [CID] },
      FieldNames: ['Id', 'AdGroupId', 'CampaignId', 'State', 'Status', 'Type', 'Subtype'],
      TextAdFieldNames: [
        'Title', 'Title2', 'Text', 'Href', 'DisplayUrlPath',
        'SitelinkSetId', 'VCardId', 'AdImageHash', 'AdExtensions', 'PriceExtension',
      ],
    })
    const ads = r?.Ads ?? []
    console.log(`Всего объявлений: ${ads.length}`)
    for (const a of ads) {
      const t = (a.TextAd ?? {}) as Record<string, unknown>
      console.log(
        `   ad ${a.Id} [grp ${a.AdGroupId}] ${a.Status} | ` +
        `sitelinks:${t.SitelinkSetId ? 'ДА' : 'нет'} vcard:${t.VCardId ? 'ДА' : 'нет'} ` +
        `callouts:${Array.isArray(t.AdExtensions) && (t.AdExtensions as unknown[]).length ? 'ДА' : 'нет'} ` +
        `price:${t.PriceExtension ? 'ДА' : 'нет'} img:${t.AdImageHash ? 'ДА' : 'нет'}`
      )
    }
    show('ad[0] (полностью)', ads[0])
    return r
  })

  // ---------- 6. Метрика: срезы, которых Борис не тянет ----------
  const mFrom = DATE_FROM
  const mTo = DATE_TO
  // Изолируем рекламный трафик (Директ), чтобы срез не был про весь сайт.
  const AD_FILTER = "ym:s:lastTrafficSource=='ad'"

  async function metrikaSlice(label: string, dimensions: string, extraMetrics = '') {
    await safe(`metrika ${label}`, async () => {
      const resp = await metrikaStat({
        dimensions,
        metrics: `ym:s:visits,${GOAL},ym:s:bounceRate,ym:s:pageDepth${extraMetrics}`,
        date1: mFrom,
        date2: mTo,
        filters: AD_FILTER,
        limit: '30',
        sort: 'ym:s:visits',
      })
      console.log(`\n— ${label} (визиты / заявки / отказы% / глубина):`)
      for (const row of resp.data) {
        const dim = row.dimensions.map((d) => d.name ?? '—').join(' / ')
        const [visits, goals, bounce, depth] = row.metrics
        const cr = visits ? ((goals / visits) * 100).toFixed(1) : '0'
        console.log(`   ${dim}: ${visits} виз, ${goals} заявок (CR ${cr}%), отказы ${bounce?.toFixed(1)}%, глуб ${depth?.toFixed(2)}`)
      }
      console.log(`   totals:`, resp.totals)
      return resp
    })
  }

  section('6. Метрика — рекламный трафик (Директ), недостающие срезы')
  await metrikaSlice('устройства', 'ym:s:deviceCategory')
  await metrikaSlice('пол', 'ym:s:gender')
  await metrikaSlice('возраст', 'ym:s:ageInterval')
  await metrikaSlice('гео (город)', 'ym:s:regionCity')
  await metrikaSlice('час дня', 'ym:s:hour')
  await metrikaSlice('день недели', 'ym:s:dayOfWeekName')

  // ---------- 7. Direct Reports: срезы device / hour (async poll) ----------
  section('7. Direct Reports — срезы device / hour (расход в разрезах)')
  async function pullReport(label: string, fieldNames: string[], groupField: string) {
    const name = `bd_recon_${label}_${Date.now()}`
    const body = {
      params: {
        SelectionCriteria: { Filter: [{ Field: 'CampaignId', Operator: 'EQUALS', Values: [String(CID)] }] },
        Goals: [String(METRIKA_GOAL_ID)],
        FieldNames: fieldNames,
        ReportName: name,
        ReportType: 'CUSTOM_REPORT',
        DateRangeType: 'LAST_30_DAYS',
        Format: 'TSV',
        IncludeVAT: 'YES',
      },
    }
    await safe(`report ${label}`, async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const poll = await pollReport(body)
        if (poll.status === 'ready') {
          console.log(`\n— Direct report «${label}» (по ${groupField}):`)
          console.log(poll.tsv.trim() || '(пусто)')
          return poll
        }
        if (poll.status === 'failed') {
          console.log(`\n[report ${label} FAILED] ${poll.error}`)
          return poll
        }
        await new Promise((r) => setTimeout(r, Math.min(poll.retryInSec, 8) * 1000))
      }
      console.log(`\n[report ${label}] не дозрел за отведённые попытки`)
      return null
    })
  }
  await pullReport('device', ['Device', 'Impressions', 'Clicks', 'Cost', 'Conversions'], 'Device')
  await pullReport('hour', ['HourOfDay', 'Impressions', 'Clicks', 'Cost', 'Conversions'], 'HourOfDay')

  console.log('\n\n========== РАЗВЕДКА ЗАВЕРШЕНА ==========')
}

main().catch((e) => {
  console.error('FATAL', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
