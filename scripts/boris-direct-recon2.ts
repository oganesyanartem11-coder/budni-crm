/**
 * РАЗВЕДКА ч.2 — досъём четырёх вызовов, упавших на именах полей/параметрах.
 * СТРОГО READ-ONLY. Запуск: dotenv -e .env.local -- tsx scripts/boris-direct-recon2.ts
 */
import { directCall } from '../src/lib/boris-direct/direct-client'
import { pollReport } from '../src/lib/boris-direct/reports'
import { DIRECT_CAMPAIGN_ID, METRIKA_GOAL_ID } from '../src/lib/boris-direct/config'

const CID = DIRECT_CAMPAIGN_ID
function section(t: string): void { console.log('\n\n========== ' + t + ' ==========') }
function show(l: string, v: unknown): void { console.log(`\n— ${l}:`); console.log(JSON.stringify(v, null, 2)) }
async function safe<T>(l: string, fn: () => Promise<T>): Promise<T | null> {
  try { return await fn() } catch (e) { console.log(`\n[ERR ${l}] ${e instanceof Error ? e.message : String(e)}`); return null }
}

async function main(): Promise<void> {
  // 1. campaigns.get — без ContextLimit (невалиден), + расписание/минуса/стратегия.
  section('1. campaigns.get (fixed)')
  await safe('campaigns.get', async () => {
    const r = await directCall<{ Campaigns?: unknown[] }>('campaigns', 'get', {
      SelectionCriteria: { Ids: [CID] },
      FieldNames: [
        'Id', 'Name', 'Type', 'State', 'Status', 'StatusPayment', 'StatusClarification',
        'SourceId', 'Currency', 'DailyBudget', 'StartDate', 'EndDate', 'Funds', 'CreateTime',
        'TimeTargeting', 'TimeZone', 'NegativeKeywords', 'BlockedIps', 'ExcludedSites', 'Statistics',
      ],
      TextCampaignFieldNames: ['BiddingStrategy', 'Settings', 'CounterIds', 'PriorityGoals', 'AttributionModel'],
    })
    show('campaign', r?.Campaigns?.[0])
    return r
  })

  // 2. bidmodifiers.get — обязательный Levels.
  section('2. bidmodifiers.get (Levels)')
  await safe('bidmodifiers.get', async () => {
    const r = await directCall<{ BidModifiers?: unknown[] }>('bidmodifiers', 'get', {
      SelectionCriteria: { CampaignIds: [CID], Levels: ['CAMPAIGN', 'AD_GROUP'] },
      FieldNames: ['Id', 'CampaignId', 'AdGroupId', 'Type', 'Level'],
      MobileAdjustmentFieldNames: ['BidModifier', 'OperatingSystemType'],
      DesktopAdjustmentFieldNames: ['BidModifier'],
      DemographicsAdjustmentFieldNames: ['Age', 'Gender', 'BidModifier'],
      RegionalAdjustmentFieldNames: ['RegionId', 'BidModifier'],
      RetargetingAdjustmentFieldNames: ['RetargetingConditionId', 'BidModifier'],
    })
    show('bidModifiers', r?.BidModifiers ?? [])
    return r
  })

  // 5. ads.get — без PriceExtension (невалиден); + BusinessId/ButtonExtension/TurboPageId.
  section('5. ads.get (fixed)')
  await safe('ads.get', async () => {
    const r = await directCall<{ Ads?: Array<Record<string, unknown>> }>('ads', 'get', {
      SelectionCriteria: { CampaignIds: [CID] },
      FieldNames: ['Id', 'AdGroupId', 'CampaignId', 'State', 'Status', 'Type', 'Subtype'],
      TextAdFieldNames: [
        'Title', 'Title2', 'Text', 'Href', 'DisplayUrlPath', 'SitelinkSetId', 'VCardId',
        'AdImageHash', 'AdExtensions', 'BusinessId', 'ButtonExtension', 'TurboPageId', 'VideoExtension',
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
        `business:${t.BusinessId ? 'ДА' : 'нет'} button:${t.ButtonExtension ? 'ДА' : 'нет'} ` +
        `turbo:${t.TurboPageId ? 'ДА' : 'нет'} img:${t.AdImageHash ? 'ДА' : 'нет'} title2:${t.Title2 ? 'ДА' : 'нет'}`
      )
    }
    show('ad[0] (полностью)', ads[0])
    return r
  })

  // 7b. Direct report — расход по дню недели (weekend waste).
  section('7b. Direct report — DayOfWeek (расход по дням недели)')
  await safe('report DayOfWeek', async () => {
    const body = {
      params: {
        SelectionCriteria: { Filter: [{ Field: 'CampaignId', Operator: 'EQUALS', Values: [String(CID)] }] },
        Goals: [String(METRIKA_GOAL_ID)],
        FieldNames: ['DayOfWeek', 'Impressions', 'Clicks', 'Cost', 'Conversions'],
        ReportName: `bd_recon_dow_${Date.now()}`,
        ReportType: 'CUSTOM_REPORT', DateRangeType: 'LAST_30_DAYS', Format: 'TSV', IncludeVAT: 'YES',
      },
    }
    for (let i = 0; i < 8; i++) {
      const poll = await pollReport(body)
      if (poll.status === 'ready') { console.log('\n' + (poll.tsv.trim() || '(пусто)')); return poll }
      if (poll.status === 'failed') { console.log('\n[FAILED] ' + poll.error); return poll }
      await new Promise((r) => setTimeout(r, Math.min(poll.retryInSec, 8) * 1000))
    }
    console.log('\n[не дозрел]')
    return null
  })

  console.log('\n\n========== ч.2 ЗАВЕРШЕНА ==========')
}
main().catch((e) => { console.error('FATAL', e instanceof Error ? e.message : e); process.exitCode = 1 })
