/**
 * Тесты фейков транспорта полигона (sim/fakes/*): без сети и БЕЗ импорта
 * движка sim/engine/world.ts — движок стабается интерфейсом WorldEngine
 * (закон sim/engine/api.ts), мир собирается вручную.
 *
 * Что проверяем (по ТЗ зоны):
 *  - фейк-присма: upsert по составному ключу не дублирует; updateMany-claim
 *    возвращает count; select отдаёт ТОЛЬКО выбранные поля; aggregate _sum;
 *    незнакомый паттерн — громкая ошибка;
 *  - fakePollReport: pending до исчерпания reportDelayPolls, TSV с '--',
 *    фильтр по диапазону дат;
 *  - llm-стаб: детерминизм и разбор кандидатов из userText, как его строит
 *    боевой brain.ts (JSON-массив {candidate, impressions, clicks, conversions});
 *  - фейк direct-client: пишет CapturedAction и зовёт мутаторы движка-стаба
 *    (updateDailyBudget — ТОЛЬКО captured, мир не трогается).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorldEngine } from '../engine/api'
import type {
  DayObservables,
  ObservedQueryRow,
  ScenarioConfig,
  WorldState,
} from '../types'
import { SimContext, simContext, dayToDate, dayToMskString } from './context'
import { fakePollReport } from './reports'
import { fakeCallBorisDirectLlm } from './llm'
import {
  getCampaignState,
  getKeywordBids,
  getKeywords,
  restoreMetricaTag,
  setKeywordBids,
  suspendCampaign,
  suspendKeywords,
  updateCampaignNegatives,
  updateDailyBudget,
} from './direct-client'
import { getGoalStatsByDay, getGoalStatsByUtm, metrikaStat } from './metrika-client'
// Тела отчётов строим БОЕВЫМ кодом (чистые функции, env читается лениво) —
// фейк обязан понимать ровно то, что шлёт мозг.
import {
  buildCampaignPerformanceReportBody,
  buildSearchQueryReportBody,
  parseReportTsv,
} from '../../src/lib/boris-direct/reports'

// ---------- Стабы мира и движка (world.ts НЕ импортируем) ----------

function makeEngineStub(): WorldEngine {
  return {
    createWorld: () => {
      throw new Error('createWorld не используется в тестах фейков')
    },
    advanceDay: () => {
      throw new Error('advanceDay не используется в тестах фейков')
    },
    setBid: vi.fn(),
    setNegatives: vi.fn(),
    suspendCampaign: vi.fn(),
    suspendKeywords: vi.fn(),
    setMetricaTag: vi.fn(),
    getTotals: () => ({ spendRub: 0, trueLeads: 0, observedLeads: 0 }),
    negativesMatch: () => false,
  }
}

function makeConfig(): ScenarioConfig {
  return {
    id: 'test-scenario',
    name: 'Тестовый мир',
    set: 'tuning',
    days: 7,
    quarantineUntilDay: 0,
    phrases: [
      {
        keywordId: 101,
        adGroupId: 'G1',
        adGroupName: 'Офисы',
        text: 'доставка обедов в офис',
        isCore: true,
        trueCtrByTv: { 15: 0.02, 65: 0.05, 75: 0.06, 85: 0.08, 100: 0.1 },
        trueCr: 0.05,
        demandPerDay: 50,
        startBidMicro: 50_000_000,
      },
    ],
    queries: [],
    ads: [{ adId: 9001, adGroupId: 'G1', textQuality: 1, rejectedFromDay: 2 }],
    events: [],
    weekdayDemand: [1, 1, 1, 1, 1, 0.1, 0.1],
    conversionLagDays: { 0: 1 },
    yclidLossRate: 0.1,
    cpcByTv: { 15: 20, 65: 45, 75: 52, 85: 120, 100: 180 },
    expectations: { causeCodes: {}, anomalies: [], notes: 'тестовый конфиг' },
  }
}

function makeWorld(config: ScenarioConfig): WorldState {
  return {
    config,
    seed: 1,
    day: 0,
    bidsMicro: new Map([[101, 50_000_000]]),
    negatives: [],
    campaignSuspended: false,
    keywordsSuspended: new Set(),
    addMetricaTag: 'YES',
    truthClicks: [],
    internal: {},
  }
}

function makeDay(day: number, over: Partial<DayObservables> = {}): DayObservables {
  return {
    day,
    queryRows: [],
    keywordBids: [],
    metrika: { day, visits: 0, goalReaches: 0, bounceRate: 0, avgDepth: 0, formReachRate: 0 },
    metrikaByUtm: [],
    newLeads: [],
    spentTodayRub: 0,
    impressionsToday: 0,
    rejectedAdsCount: 0,
    addMetricaTag: 'YES',
    ...over,
  }
}

function queryRow(day: number, query: string, over: Partial<ObservedQueryRow> = {}): ObservedQueryRow {
  return {
    day,
    query,
    keywordId: 1,
    adGroupId: 'G1',
    adGroupName: 'Офисы',
    impressions: 0,
    clicks: 0,
    costRub: 0,
    conversions: 0,
    ...over,
  }
}

let engine: WorldEngine
let ctx: SimContext

beforeEach(() => {
  engine = makeEngineStub()
  ctx = new SimContext({
    engine,
    world: makeWorld(makeConfig()),
    policy: 'boris',
    llmMode: 'stub',
  })
  simContext.current = ctx
})

afterEach(() => {
  simContext.current = null
})

// ---------- Контекст ----------

describe('SimContext', () => {
  it('фейк без установленного контекста падает с внятной ошибкой', async () => {
    simContext.current = null
    await expect(getCampaignState()).rejects.toThrow(/SimContext не установлен/)
  })
})

// ---------- Фейк-присма ----------

describe('фейк-присма', () => {
  it('upsert по составному ключу date_query_adGroupId не дублирует строку', async () => {
    const p = ctx.fakePrisma
    const date = dayToDate(0)
    const where = {
      date_query_adGroupId: { date, query: 'доставка обедов казань', adGroupId: 'G1' },
    }
    const create = {
      date,
      query: 'доставка обедов казань',
      adGroupId: 'G1',
      adGroupName: 'Офисы',
      impressions: 10,
      clicks: 1,
      costRub: 50,
      conversions: 0,
    }
    await p.borisDirectQueryDailyStat.upsert({ where, create, update: {} })
    await p.borisDirectQueryDailyStat.upsert({
      where,
      create,
      update: { impressions: 25, clicks: 2 },
    })
    // Другой ключ (другой запрос) — отдельная строка.
    await p.borisDirectQueryDailyStat.upsert({
      where: { date_query_adGroupId: { date, query: 'обеды в офис', adGroupId: 'G1' } },
      create: { ...create, query: 'обеды в офис' },
      update: {},
    })

    const rows = await p.borisDirectQueryDailyStat.findMany({
      where: { date: { gte: new Date(date.getTime() - 1), lt: new Date(date.getTime() + 1) } },
    })
    expect(rows).toHaveLength(2)
    const updated = rows.find((r) => r.query === 'доставка обедов казань')
    expect(updated?.impressions).toBe(25)
    expect(updated?.clicks).toBe(2)
  })

  it('updateMany-claim возвращает count и берёт запись только один раз', async () => {
    const p = ctx.fakePrisma
    const proposal = await p.borisDirectProposal.create({
      data: {
        type: 'minus_words',
        topicKey: 'minus_words',
        payload: { phrases: ['казань'] },
        argument: 'аргумент',
        question: 'вопрос',
      },
    })
    expect(proposal.status).toBe('PENDING') // дефолт схемы

    const claim1 = await p.borisDirectProposal.updateMany({
      where: { id: proposal.id, status: 'PENDING' },
      data: { status: 'ACCEPTED', decidedAt: dayToDate(1) },
    })
    expect(claim1.count).toBe(1)

    const claim2 = await p.borisDirectProposal.updateMany({
      where: { id: proposal.id, status: 'PENDING' },
      data: { status: 'REJECTED' },
    })
    expect(claim2.count).toBe(0) // двойной клик не решает дважды

    const row = await p.borisDirectProposal.findUnique({ where: { id: proposal.id } })
    expect(row?.status).toBe('ACCEPTED')
  })

  it('select возвращает ТОЛЬКО выбранные поля (и distinct схлопывает дубли)', async () => {
    const p = ctx.fakePrisma
    const tickDate = dayToDate(0)
    await p.borisDirectSnapshot.create({ data: { tickDate, kind: 'campaign', payload: { a: 1 } } })
    await p.borisDirectSnapshot.create({ data: { tickDate, kind: 'campaign', payload: { a: 2 } } })

    const rows = await p.borisDirectSnapshot.findMany({
      where: { kind: 'campaign' },
      select: { tickDate: true },
      distinct: ['tickDate'],
    })
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0])).toEqual(['tickDate'])
  })

  it('aggregate считает _sum/_count, на пустой выборке _sum = null', async () => {
    const p = ctx.fakePrisma
    await p.borisDirectLlmLog.create({
      data: { purpose: 'minus_classify', model: 'stub', tier: 'light', costUsd: 0.5 },
    })
    await p.borisDirectLlmLog.create({
      data: { purpose: 'minus_classify', model: 'stub', tier: 'light', costUsd: 0.25 },
    })

    const agg = await p.borisDirectLlmLog.aggregate({
      where: { createdAt: { gte: dayToDate(0) } },
      _sum: { costUsd: true },
      _count: { _all: true },
    })
    expect(agg._sum?.costUsd).toBeCloseTo(0.75, 6)
    expect(agg._count?._all).toBe(2)

    const empty = await p.borisDirectLlmLog.aggregate({
      where: { createdAt: { gte: dayToDate(5) } },
      _sum: { costUsd: true },
    })
    expect(empty._sum?.costUsd).toBeNull()
  })

  it('незнакомый паттерн запроса падает громко (unsupported query)', async () => {
    const p = ctx.fakePrisma
    await expect(
      p.borisDirectActionLog.findMany({ where: { reason: { contains: 'х' } } })
    ).rejects.toThrow(/unsupported query/)
    await expect(
      p.borisDirectProposal.findMany({ where: { OR: [{ status: 'PENDING' }] } })
    ).rejects.toThrow(/unsupported query/)
  })

  it('id = sim<счётчик>, createdAt — из виртуальных часов (clockDay)', async () => {
    const p = ctx.fakePrisma
    ctx.clockDay = 3
    const row = await p.borisDirectActionLog.create({
      data: {
        action: 'keywordbids.set',
        targetType: 'keyword',
        reason: 'тест',
        mode: 'OBSERVE',
        applied: false,
      },
    })
    expect(String(row.id)).toMatch(/^sim\d+$/)
    expect((row.createdAt as Date).getTime()).toBe(dayToDate(3).getTime())
    // Дефолты необязательных полей — как в схеме.
    expect(row.revertedAt).toBeNull()
    expect(row.outcomeMeasuredAt).toBeNull()
  })

  it('reset() контекста чистит таблицы фейк-присмы', async () => {
    const p = ctx.fakePrisma
    await p.borisDirectSnapshot.create({
      data: { tickDate: dayToDate(0), kind: 'keywords', payload: [] },
    })
    ctx.reset()
    expect(await p.borisDirectSnapshot.findMany()).toEqual([])
  })

  it('deleteMany удаляет строки по where и возвращает count (прунинг трассы)', async () => {
    const p = ctx.fakePrisma
    await p.borisDirectSnapshot.create({ data: { tickDate: dayToDate(0), kind: 'decisions', payload: [1] } })
    await p.borisDirectSnapshot.create({ data: { tickDate: dayToDate(5), kind: 'decisions', payload: [2] } })
    await p.borisDirectSnapshot.create({ data: { tickDate: dayToDate(5), kind: 'keywords', payload: [] } })
    const res = await p.borisDirectSnapshot.deleteMany({
      where: { kind: 'decisions', tickDate: { lt: dayToDate(3) } },
    })
    expect(res).toEqual({ count: 1 })
    const left = await p.borisDirectSnapshot.findMany({ where: { kind: 'decisions' } })
    expect(left).toHaveLength(1)
    expect((left[0].tickDate as Date).getTime()).toBe(dayToDate(5).getTime())
  })
})

// ---------- fakePollReport ----------

describe('fakePollReport', () => {
  /** Мир на два дня: queryRows ПОСЛЕДНЕГО дня содержат строки обоих (семантика движка). */
  function seedTwoDays(): void {
    const day0Rows = [
      queryRow(0, 'доставка обедов в офис', {
        impressions: 100,
        clicks: 7,
        costRub: 350.5,
        conversions: 2,
      }),
      queryRow(0, 'доставка обедов казань', { impressions: 40, clicks: 2, costRub: 90, conversions: 0 }),
    ]
    const day1Rows = [
      ...day0Rows,
      queryRow(1, 'доставка обедов в офис', {
        impressions: 50,
        clicks: 3,
        costRub: 149.5,
        conversions: 1,
      }),
    ]
    ctx.days = [makeDay(0, { queryRows: day0Rows }), makeDay(1, { queryRows: day1Rows })]
  }

  it('reportDelayPolls: сперва pending, потом готовый TSV', async () => {
    seedTwoDays()
    ctx.reportDelayPolls = 2
    const body = buildSearchQueryReportBody(dayToMskString(0), dayToMskString(0), 'bd_sq_test')

    expect(await fakePollReport(body)).toEqual({ status: 'pending', retryInSec: 60 })
    expect(await fakePollReport(body)).toEqual({ status: 'pending', retryInSec: 60 })
    const третий = await fakePollReport(body)
    expect(третий.status).toBe('ready')
  })

  it('SEARCH_QUERY: заголовок из FieldNames, Cost с 2 знаками, 0 конверсий → «--», диапазон режет', async () => {
    seedTwoDays()
    const body = buildSearchQueryReportBody(dayToMskString(0), dayToMskString(0), 'bd_sq_test')
    const poll = await fakePollReport(body)
    if (poll.status !== 'ready') throw new Error(`ожидали ready, got ${poll.status}`)

    const [header] = poll.tsv.split('\n')
    expect(header).toBe(
      ['Query', 'AdGroupName', 'AdGroupId', 'CriterionId', 'Impressions', 'Clicks', 'Cost', 'Conversions'].join('\t')
    )

    const rows = parseReportTsv(poll.tsv) // боевой парсер понимает наш TSV
    expect(rows).toHaveLength(2) // строка дня 1 в диапазон НЕ попала
    const trash = rows.find((r) => r.Query === 'доставка обедов казань')
    expect(trash).toMatchObject({ AdGroupId: 'G1', Impressions: '40', Clicks: '2', Cost: '90.00' })
    expect(trash?.Conversions).toBe('--') // ноль конверсий — как у Директа
    const target = rows.find((r) => r.Query === 'доставка обедов в офис')
    expect(target).toMatchObject({ Cost: '350.50', Conversions: '2' })
  })

  it('SEARCH_QUERY: диапазон в 2 дня агрегирует по (query, группа)', async () => {
    seedTwoDays()
    const body = buildSearchQueryReportBody(dayToMskString(0), dayToMskString(1), 'bd_sq_test2')
    const poll = await fakePollReport(body)
    if (poll.status !== 'ready') throw new Error('ожидали ready')

    const rows = parseReportTsv(poll.tsv)
    const target = rows.find((r) => r.Query === 'доставка обедов в офис')
    expect(target).toMatchObject({
      Impressions: '150',
      Clicks: '10',
      Cost: '500.00',
      Conversions: '3',
    })
  })

  it('CUSTOM_REPORT: строка на (день, группу), Date по МСК, Ctr/AvgCpc посчитаны', async () => {
    seedTwoDays()
    const body = buildCampaignPerformanceReportBody(dayToMskString(0), dayToMskString(1), 'bd_cp_test')
    const poll = await fakePollReport(body)
    if (poll.status !== 'ready') throw new Error('ожидали ready')

    const rows = parseReportTsv(poll.tsv)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      Date: '2026-07-06', // день 0 = понедельник 6 июля 2026 (МСК)
      AdGroupId: 'G1',
      Impressions: '140',
      Clicks: '9',
      Cost: '440.50',
      Ctr: '6.43',
      AvgCpc: '48.94',
      Conversions: '2',
    })
    expect(rows[1]).toMatchObject({ Date: '2026-07-07', Impressions: '50', Conversions: '1' })
  })

  it('незнакомый ReportType падает громко', async () => {
    seedTwoDays()
    const body = {
      params: {
        SelectionCriteria: { DateFrom: dayToMskString(0), DateTo: dayToMskString(0) },
        FieldNames: ['Query'],
        ReportType: 'ACCOUNT_PERFORMANCE_REPORT',
      },
    }
    await expect(fakePollReport(body)).rejects.toThrow(/unsupported query/)
  })
})

// ---------- llm-стаб ----------

describe('llm-стаб (minus_classify)', () => {
  // userText РОВНО в форме brain.ts: JSON.stringify(accepted.map(phrase =>
  // ({candidate, impressions, clicks, conversions}))).
  const userText = JSON.stringify([
    { candidate: 'доставка обедов казань', impressions: 42, clicks: 3, conversions: 0 },
    { candidate: 'доставка обедов в офис москва', impressions: 120, clicks: 9, conversions: 0 },
  ])
  const call = { purpose: 'minus_classify', tier: 'light' as const, system: 'системный промпт', userText }

  it('парсит кандидатов и метит мусор по маркерам, детерминированно', async () => {
    const res1 = await fakeCallBorisDirectLlm(call)
    expect(res1.model).toBe('stub')
    expect(res1.costUsd).toBe(0)
    expect(res1.downgraded).toBe(false)

    const verdicts = JSON.parse(res1.text) as Array<Record<string, unknown>>
    expect(verdicts).toHaveLength(2)
    expect(verdicts[0]).toMatchObject({
      candidate: 'доставка обедов казань', // город вне МО → структурный мусор
      structural: true,
      confident: true,
    })
    expect(verdicts[1]).toMatchObject({
      candidate: 'доставка обедов в офис москва', // целевой → спорный
      structural: false,
      confident: false,
    })
    // Форма ответа совместима с parseClassifierJson мозга: reason — строка.
    expect(typeof verdicts[0].reason).toBe('string')

    const res2 = await fakeCallBorisDirectLlm(call)
    expect(res2.text).toBe(res1.text) // детерминизм
  })

  it('битый userText → пустой массив вердиктов (все кандидаты спорные)', async () => {
    const res = await fakeCallBorisDirectLlm({ ...call, userText: 'не json вовсе' })
    expect(res.text).toBe('[]')
  })

  it('прочие purpose получают заглушку sim-stub', async () => {
    const res = await fakeCallBorisDirectLlm({
      purpose: 'daily_report',
      tier: 'heavy',
      system: 'с',
      userText: 'отчёт',
    })
    expect(res).toEqual({ text: 'sim-stub', model: 'stub', costUsd: 0, downgraded: false })
  })
})

// ---------- Фейк direct-client ----------

describe('фейк direct-client', () => {
  it('setKeywordBids зовёт engine.setBid по каждой ставке и пишет CapturedAction', async () => {
    ctx.clockDay = 2
    await setKeywordBids([
      { keywordId: 101, searchBidMicro: 60_000_000 },
      { keywordId: 102, searchBidMicro: 20_000_000 },
    ])

    expect(engine.setBid).toHaveBeenCalledTimes(2)
    expect(engine.setBid).toHaveBeenCalledWith(ctx.world, 101, 60_000_000)
    expect(engine.setBid).toHaveBeenCalledWith(ctx.world, 102, 20_000_000)

    expect(ctx.captured).toEqual([
      {
        day: 2,
        type: 'bid_set',
        // Форма payload — по закону sim/types.ts: [{keywordId, toMicro}].
        payload: [
          { keywordId: 101, toMicro: 60_000_000 },
          { keywordId: 102, toMicro: 20_000_000 },
        ],
        by: 'boris',
      },
    ])
  })

  it('updateCampaignNegatives зовёт engine.setNegatives полным списком', async () => {
    await updateCampaignNegatives(['казань', 'бесплатно'])
    expect(engine.setNegatives).toHaveBeenCalledWith(ctx.world, ['казань', 'бесплатно'])
    expect(ctx.captured).toEqual([
      { day: 0, type: 'negatives_set', payload: ['казань', 'бесплатно'], by: 'boris' },
    ])
  })

  it('restoreMetricaTag возвращает YES через движок', async () => {
    await restoreMetricaTag()
    expect(engine.setMetricaTag).toHaveBeenCalledWith(ctx.world, 'YES')
    expect(ctx.captured[0]).toMatchObject({ type: 'metrica_tag_restore' })
  })

  it('suspendKeywords / suspendCampaign останавливают через движок', async () => {
    await suspendKeywords([101])
    await suspendCampaign()
    expect(engine.suspendKeywords).toHaveBeenCalledWith(ctx.world, [101])
    expect(engine.suspendCampaign).toHaveBeenCalledWith(ctx.world)
    expect(ctx.captured.map((a) => a.type)).toEqual(['keywords_suspend', 'campaign_suspend'])
  })

  it('updateDailyBudget пишет ТОЛЬКО captured — мир не трогается', async () => {
    await updateDailyBudget(5_000_000_000)
    expect(ctx.captured).toEqual([
      { day: 0, type: 'daily_budget', payload: { amountMicro: 5_000_000_000 }, by: 'boris' },
    ])
    expect(engine.setBid).not.toHaveBeenCalled()
    expect(engine.setNegatives).not.toHaveBeenCalled()
    expect(engine.suspendKeywords).not.toHaveBeenCalled()
    expect(engine.suspendCampaign).not.toHaveBeenCalled()
    expect(engine.setMetricaTag).not.toHaveBeenCalled()
  })

  it('getCampaignState/getKeywords отражают видимое состояние мира', async () => {
    ctx.world.addMetricaTag = 'NO'
    ctx.world.campaignSuspended = true
    ctx.world.keywordsSuspended.add(101)

    const campaign = await getCampaignState()
    expect(campaign.State).toBe('SUSPENDED')
    expect(campaign.StatusPayment).toBe('ALLOWED')
    expect(campaign.DailyBudget).toEqual({ Amount: 3_000_000_000, Mode: 'STANDARD' })
    expect(campaign.TextCampaign?.CounterIds).toEqual({ Items: [110272989] })
    expect(
      campaign.TextCampaign?.Settings?.find((s) => s.Option === 'ADD_METRICA_TAG')?.Value
    ).toBe('NO')

    const keywords = await getKeywords()
    expect(keywords).toHaveLength(1)
    expect(keywords[0]).toMatchObject({
      Id: 101,
      Keyword: 'доставка обедов в офис',
      State: 'SUSPENDED',
      Bid: 50_000_000,
    })
    // adGroupId мира строковый — мозг всегда делает String(AdGroupId).
    expect(String(keywords[0].AdGroupId)).toBe('G1')
  })

  it('getKeywordBids читает аукцион из ПОСЛЕДНЕГО наблюдаемого дня (микроединицы)', async () => {
    ctx.days = [
      makeDay(0, {
        keywordBids: [
          {
            keywordId: 101,
            adGroupId: 'G1',
            bidMicro: 50_000_000,
            auction: [{ tv: 75, bidMicro: 52_000_000, priceMicro: 52_000_000 }],
          },
        ],
      }),
    ]
    const bids = await getKeywordBids()
    expect(bids).toHaveLength(1)
    expect(bids[0].KeywordId).toBe(101)
    expect(bids[0].Search?.Bid).toBe(50_000_000)
    expect(bids[0].Search?.AuctionBids).toEqual([
      { TrafficVolume: 75, Bid: 52_000_000, Price: 52_000_000 },
    ])

    ctx.days = []
    expect(await getKeywordBids()).toEqual([]) // дней нет — пусто, мозг пропустит блок
  })
})

// ---------- Фейк metrika-client ----------

describe('фейк metrika-client', () => {
  beforeEach(() => {
    ctx.days = [
      makeDay(0, {
        metrika: { day: 0, visits: 10, goalReaches: 1, bounceRate: 0.2, avgDepth: 3, formReachRate: 0.3 },
        metrikaByUtm: [{ utmTerm: 'доставка обедов в офис', visits: 8, goalReaches: 1 }],
      }),
      makeDay(1, {
        metrika: { day: 1, visits: 6, goalReaches: 2, bounceRate: 0.5, avgDepth: 2, formReachRate: 0.2 },
        metrikaByUtm: [{ utmTerm: 'доставка обедов в офис', visits: 5, goalReaches: 2 }],
      }),
    ]
  })

  it('getGoalStatsByDay отдаёт только дни диапазона в формате YYYY-MM-DD', async () => {
    const rows = await getGoalStatsByDay(dayToMskString(1), dayToMskString(1))
    expect(rows).toEqual([{ date: '2026-07-07', visits: 6, goalReaches: 2 }])
  })

  it('getGoalStatsByUtm агрегирует metrikaByUtm за диапазон по utmTerm', async () => {
    const rows = await getGoalStatsByUtm(dayToMskString(0), dayToMskString(1))
    expect(rows).toEqual([
      {
        utmSource: 'yandex-direct',
        utmCampaign: 'test-scenario',
        utmTerm: 'доставка обедов в офис',
        visits: 13,
        goalReaches: 3,
      },
    ])
  })

  it('сырой metrikaStat не поддержан — громкая ошибка', async () => {
    await expect(metrikaStat({ metrics: 'ym:s:visits' })).rejects.toThrow(/unsupported in sim/)
  })
})
