import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Мозг (два тика дневного цикла). Все клиенты, prisma, write-gate и LLM
 * мокаются на уровне МОДУЛЕЙ — без сети, БД и Anthropic. Чистые функции
 * (rules, anomalies, парсеры отчётов/атрибуции) работают настоящие.
 */

const { mockPrisma, mockDirect, mockPollReport, mockGetGoalStatsByDay, mockGetLeads, mockGate, mockGetState, mockLlm } =
  vi.hoisted(() => ({
    mockPrisma: {
      borisDirectSnapshot: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
      borisDirectReportJob: {
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
      borisDirectActionLog: { findFirst: vi.fn() },
      landingLead: { count: vi.fn() },
    },
    mockDirect: {
      getCampaignState: vi.fn(),
      getKeywords: vi.fn(),
      getKeywordBids: vi.fn(),
    },
    mockPollReport: vi.fn(),
    mockGetGoalStatsByDay: vi.fn(),
    mockGetLeads: vi.fn(),
    mockGate: {
      applyBidChanges: vi.fn(),
      applyNegativeKeywords: vi.fn(),
    },
    mockGetState: vi.fn(),
    mockLlm: vi.fn(),
  }))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('./direct-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./direct-client')>()
  return { ...actual, ...mockDirect }
})
vi.mock('./reports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reports')>()
  return { ...actual, pollReport: mockPollReport }
})
vi.mock('./metrika-client', () => ({ getGoalStatsByDay: mockGetGoalStatsByDay }))
vi.mock('./attribution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./attribution')>()
  return { ...actual, getLeadsForPeriod: mockGetLeads }
})
vi.mock('./write-gate', () => mockGate)
vi.mock('./state', () => ({ getDirectRoleState: mockGetState }))
vi.mock('./llm', () => ({ callBorisDirectLlm: mockLlm }))
vi.mock('./prompts', () => ({ getBorisDirectSystemPrompt: () => 'SYS' }))

import { runCollectTick, runProcessTick, mskDay, yesterdayMsk } from './brain'
import { MICRO } from './config'

// 2026-07-02 09:00 UTC → сегодня-МСК 2026-07-02, вчера-МСК 2026-07-01.
const NOW = new Date('2026-07-02T09:00:00Z')
const YESTERDAY = '2026-07-01'

const SQ_TSV = [
  'Query\tAdGroupName\tAdGroupId\tImpressions\tClicks\tCost\tConversions',
  'доставка обедов в офис\tG1\t1\t120\t10\t500\t2',
  'чужое кафе вакансии\tG2\t2\t80\t3\t100\t0',
  'корпоративное питание тендер\tG2\t2\t50\t2\t90\t--',
].join('\n')

const CP_TSV = [
  'Date\tAdGroupId\tAdGroupName\tImpressions\tClicks\tCtr\tCost\tAvgCpc\tConversions',
  '2026-07-01\t1\tG1\t150\t12\t8.0\t600\t50\t2',
  '2026-07-01\t2\tG2\t130\t5\t3.8\t190\t38\t0',
].join('\n')

const AUCTION = [
  { TrafficVolume: 100, Bid: 900 * MICRO, Price: 850 * MICRO },
  { TrafficVolume: 85, Bid: 700 * MICRO, Price: 650 * MICRO },
  { TrafficVolume: 75, Bid: 200 * MICRO, Price: 180 * MICRO },
  { TrafficVolume: 65, Bid: 150 * MICRO, Price: 140 * MICRO },
  { TrafficVolume: 15, Bid: 50 * MICRO, Price: 40 * MICRO },
]

const KEYWORDS_PAYLOAD = [
  { Id: 11, Keyword: 'доставка обедов в офис', AdGroupId: 1, State: 'ON', Status: 'ACCEPTED' },
]

const BIDS_PAYLOAD = [
  // Группа 1 конвертит (2 заявки в SQ) → proven → цель TV75 (Bid 200 ₽), сейчас 100 ₽.
  { KeywordId: 11, AdGroupId: 1, CampaignId: 711897777, Search: { Bid: 100 * MICRO, AuctionBids: AUCTION } },
  // Группа 2 хвост → TV15 (Bid 50 ₽), сейчас 50 ₽ → микрошум, не трогаем.
  { KeywordId: 22, AdGroupId: 2, CampaignId: 711897777, Search: { Bid: 50 * MICRO, AuctionBids: AUCTION } },
]

const CAMPAIGN_TAG_YES = {
  Id: 711897777,
  Name: 'Будни — Поиск — Волна 1',
  State: 'ON',
  Status: 'ACCEPTED',
  StatusPayment: 'ALLOWED',
  Type: 'TEXT_CAMPAIGN',
  TextCampaign: { Settings: [{ Option: 'ADD_METRICA_TAG', Value: 'YES' }] },
}

const LLM_CLASSIFY_OK = JSON.stringify([
  { candidate: 'чужое кафе вакансии', structural: true, confident: true, reason: 'вакансии — не заявки' },
  { candidate: 'корпоративное питание тендер', structural: false, confident: false, reason: 'может быть целевой B2B' },
])

function setState(state: { mode: 'OBSERVE' | 'LIVE'; frozen?: boolean; autoNegativesEnabled?: boolean }) {
  mockGetState.mockResolvedValue({
    mode: state.mode,
    frozen: state.frozen ?? false,
    autoNegativesEnabled: state.autoNegativesEnabled ?? false,
  })
}

/** База happy-path для тика «обработка»: отчёты готовы, карантин пройден. */
function setupProcessHappyPath() {
  mockPrisma.borisDirectReportJob.findMany.mockResolvedValue([]) // PENDING нет
  mockPrisma.borisDirectReportJob.findFirst.mockImplementation(async (args: { where: { reportType: string } }) => {
    if (args.where.reportType === 'SEARCH_QUERY_PERFORMANCE_REPORT') return { id: 'sq1', tsv: SQ_TSV }
    if (args.where.reportType === 'CUSTOM_REPORT') return { id: 'cp1', tsv: CP_TSV }
    return null
  })
  mockPrisma.borisDirectSnapshot.create.mockResolvedValue({})
  mockPrisma.borisDirectSnapshot.findMany.mockImplementation(async (args: { where: { kind: string } }) => {
    if (args.where.kind === 'campaign') {
      // 6 дней с данными → карантин по дням пройден.
      return Array.from({ length: 6 }, (_, i) => ({ tickDate: new Date(`2026-06-2${5 + (i % 5)}T00:00:00Z`) }))
    }
    if (args.where.kind === 'daily_totals') {
      // Σ кликов 40 ≥ 30 → карантин по кликам пройден.
      return [
        { tickDate: new Date('2026-06-28T21:00:00Z'), payload: { date: '2026-06-28', spendRub: 500, clicks: 40, impressions: 200 } },
      ]
    }
    return []
  })
  mockPrisma.borisDirectSnapshot.findFirst.mockImplementation(async (args: { where: { kind: string } }) => {
    if (args.where.kind === 'keywords') return { payload: KEYWORDS_PAYLOAD }
    if (args.where.kind === 'keywordbids') return { payload: BIDS_PAYLOAD }
    return null
  })
  mockPrisma.borisDirectReportJob.updateMany.mockResolvedValue({ count: 2 })
  mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue(null) // прежних минусов нет
  mockGetLeads.mockResolvedValue([
    {
      id: 'lead1',
      createdAt: new Date('2026-07-01T10:00:00Z'),
      yclid: 'y1',
      gclid: null,
      utmSource: 'yandex',
      utmMedium: 'cpc',
      utmCampaign: null,
      utmTerm: null,
      source: null,
      phoneDigits: null,
    },
  ])
  mockLlm.mockResolvedValue({ text: LLM_CLASSIFY_OK, model: 'haiku', costUsd: 0.001, downgraded: false })
  mockGate.applyNegativeKeywords.mockResolvedValue({ applied: true, logId: 'n1' })
  mockGate.applyBidChanges.mockResolvedValue({ applied: true, logId: 'b1', clamped: 0, breakerTripped: false })
  setState({ mode: 'LIVE' })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('хелперы времени (МСК = UTC+3)', () => {
  it('mskDay: 22:30 UTC — это уже следующий день по МСК', () => {
    expect(mskDay(new Date('2026-07-01T22:30:00Z'))).toBe('2026-07-02')
    expect(mskDay(new Date('2026-07-01T12:00:00Z'))).toBe('2026-07-01')
  })

  it('yesterdayMsk: dateFrom=dateTo=вчерашний МСК-день', () => {
    expect(yesterdayMsk(NOW)).toEqual({ dateFrom: YESTERDAY, dateTo: YESTERDAY })
  })
})

describe('runCollectTick', () => {
  function setupCollect() {
    mockDirect.getCampaignState.mockResolvedValue(CAMPAIGN_TAG_YES)
    mockDirect.getKeywords.mockResolvedValue(KEYWORDS_PAYLOAD)
    mockDirect.getKeywordBids.mockResolvedValue(BIDS_PAYLOAD)
    mockGetGoalStatsByDay.mockResolvedValue([{ date: YESTERDAY, visits: 40, goalReaches: 2 }])
    mockPrisma.borisDirectSnapshot.create.mockResolvedValue({})
    mockPrisma.borisDirectSnapshot.findMany.mockResolvedValue([]) // истории итогов ещё нет
    let n = 0
    mockPrisma.borisDirectReportJob.create.mockImplementation(async () => ({ id: `job-${++n}` }))
    mockPrisma.borisDirectReportJob.update.mockResolvedValue({})
    mockPrisma.landingLead.count.mockResolvedValue(0)
  }

  it('снапшоты + заказ двух отчётов за вчера + первый шаг поллинга', async () => {
    setupCollect()
    mockPollReport
      .mockResolvedValueOnce({ status: 'ready', tsv: SQ_TSV })
      .mockResolvedValueOnce({ status: 'pending', retryInSec: 30 })

    const res = await runCollectTick(NOW)

    // Четыре снапшота: campaign/keywords/keywordbids (сегодня) + metrika_goal (вчера).
    const kinds = mockPrisma.borisDirectSnapshot.create.mock.calls.map((c) => c[0].data.kind)
    expect(kinds).toEqual(['campaign', 'keywords', 'keywordbids', 'metrika_goal'])

    // Два отчёта с уникальными именами за вчера.
    expect(res.requestedReports).toHaveLength(2)
    expect(res.requestedReports[0]).toMatch(/^bd_sq_20260701_\d+$/)
    expect(res.requestedReports[1]).toMatch(/^bd_cp_20260701_\d+$/)
    const jobData = mockPrisma.borisDirectReportJob.create.mock.calls.map((c) => c[0].data)
    expect(jobData[0]).toMatchObject({ reportType: 'SEARCH_QUERY_PERFORMANCE_REPORT', dateFrom: YESTERDAY, dateTo: YESTERDAY })
    expect(jobData[1]).toMatchObject({ reportType: 'CUSTOM_REPORT', dateFrom: YESTERDAY })

    // Первый poll: готовый → READY + tsv, готовящийся → остаётся PENDING (attempts=1).
    const updates = mockPrisma.borisDirectReportJob.update.mock.calls.map((c) => c[0])
    expect(updates[0].data).toMatchObject({ status: 'READY', tsv: SQ_TSV })
    expect(updates[1].data).toEqual({ attempts: 1 })

    // Спокойный день, тег YES → аномалий нет; катастрофу пока не меряем.
    expect(res.anomalies).toEqual([])
    expect(res.catastrophe).toBe(false)
  })

  it('ADD_METRICA_TAG=NO → critical-аномалия', async () => {
    setupCollect()
    mockDirect.getCampaignState.mockResolvedValue({
      ...CAMPAIGN_TAG_YES,
      TextCampaign: { Settings: [{ Option: 'ADD_METRICA_TAG', Value: 'NO' }] },
    })
    mockPollReport.mockResolvedValue({ status: 'pending', retryInSec: 30 })

    const res = await runCollectTick(NOW)

    expect(res.anomalies).toContainEqual(
      expect.objectContaining({ severity: 'critical', kind: 'metrica_tag_off' })
    )
  })

  it('упавший клиент не роняет тик: ошибка уходит в аномалию api_errors', async () => {
    setupCollect()
    mockDirect.getKeywords.mockRejectedValue(new Error('HTTP 500'))
    mockPollReport.mockResolvedValue({ status: 'pending', retryInSec: 30 })

    const res = await runCollectTick(NOW)

    const anomaly = res.anomalies.find((a) => a.kind === 'api_errors')
    expect(anomaly?.text).toContain('keywords.get')
    // Остальные снапшоты всё равно сняты.
    const kinds = mockPrisma.borisDirectSnapshot.create.mock.calls.map((c) => c[0].data.kind)
    expect(kinds).toContain('campaign')
    expect(kinds).toContain('metrika_goal')
  })
})

describe('runProcessTick', () => {
  it('отчёты не готовы → waiting_report (PENDING дожимается тем же POST)', async () => {
    setState({ mode: 'LIVE' })
    mockPrisma.borisDirectReportJob.findMany.mockResolvedValue([
      { id: 'j1', params: { params: {} }, attempts: 1 },
    ])
    mockPollReport.mockResolvedValue({ status: 'pending', retryInSec: 60 })
    mockPrisma.borisDirectReportJob.update.mockResolvedValue({})
    mockPrisma.borisDirectReportJob.findFirst.mockResolvedValue(null)

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('waiting_report')
    expect(res.reportData).toBeNull()
    expect(mockPrisma.borisDirectReportJob.update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: { attempts: 2 },
    })
    expect(mockGate.applyBidChanges).not.toHaveBeenCalled()
    expect(mockGate.applyNegativeKeywords).not.toHaveBeenCalled()
  })

  it('поллинг исчерпал лимит попыток → FAILED', async () => {
    setState({ mode: 'LIVE' })
    mockPrisma.borisDirectReportJob.findMany.mockResolvedValue([
      { id: 'j1', params: { params: {} }, attempts: 10 },
    ])
    mockPollReport.mockResolvedValue({ status: 'pending', retryInSec: 60 })
    mockPrisma.borisDirectReportJob.update.mockResolvedValue({})
    mockPrisma.borisDirectReportJob.findFirst.mockResolvedValue(null)

    await runProcessTick(NOW)

    expect(mockPrisma.borisDirectReportJob.update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: expect.objectContaining({ status: 'FAILED', attempts: 11 }),
    })
  })

  it('карантин: только отчёт, никакой оптимизации', async () => {
    setupProcessHappyPath()
    // Всего 2 дня с данными → карантин по дням.
    mockPrisma.borisDirectSnapshot.findMany.mockImplementation(async (args: { where: { kind: string } }) => {
      if (args.where.kind === 'campaign') return [{ tickDate: new Date() }, { tickDate: new Date() }]
      return []
    })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('quarantine')
    expect(res.reportData).toMatchObject({ quarantine: true, dateLabel: YESTERDAY })
    expect(mockGate.applyBidChanges).not.toHaveBeenCalled()
    expect(mockGate.applyNegativeKeywords).not.toHaveBeenCalled()
    expect(mockLlm).not.toHaveBeenCalled()
    // Отчёты помечены обработанными.
    expect(mockPrisma.borisDirectReportJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['sq1', 'cp1'] } } })
    )
  })

  it('happy-path LIVE: автономный минус применён, спорный ушёл в предложение, ставки к шкале', async () => {
    setupProcessHappyPath()

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')

    // МИНУСА: структурный+уверенный кандидат ушёл автономно (список ЗАМЕЩАЮЩИЙ:
    // union прежнего применённого списка (пусто) и новых фраз).
    expect(mockGate.applyNegativeKeywords).toHaveBeenCalledTimes(1)
    expect(mockGate.applyNegativeKeywords).toHaveBeenCalledWith(
      ['чужое кафе вакансии'],
      [],
      expect.stringContaining('минусовка')
    )

    // Спорный — в ProposalDraft с вердиктами и цифрами.
    expect(res.proposalDrafts).toHaveLength(1)
    const draft = res.proposalDrafts[0]
    expect(draft.type).toBe('minus_words')
    expect(draft.topicKey).toBe('minus_words')
    expect((draft.payload as { phrases: string[] }).phrases).toEqual(['корпоративное питание тендер'])
    expect(draft.argument).toContain('50 показов')
    expect(draft.question).toBe('Занести в минусы?')

    // Вердикты по обоим кандидатам.
    expect(res.verdicts).toContainEqual(
      expect.objectContaining({ candidate: 'чужое кафе вакансии', verdict: 'minus' })
    )
    expect(res.verdicts).toContainEqual(
      expect.objectContaining({ candidate: 'корпоративное питание тендер', verdict: 'keep' })
    )

    // СТАВКИ: конвертер группы 1 → TV75 (200 ₽); хвост уже на месте (микрошум).
    expect(mockGate.applyBidChanges).toHaveBeenCalledTimes(1)
    expect(mockGate.applyBidChanges).toHaveBeenCalledWith(
      [{ keywordId: 11, fromMicro: 100 * MICRO, toMicro: 200 * MICRO }],
      expect.stringContaining('ставки')
    )

    expect(res.appliedSummaries).toHaveLength(2)
    expect(res.wouldDoSummaries).toHaveLength(0)

    // Данные дневного отчёта — вся арифметика посчитана кодом.
    expect(res.reportData).toMatchObject({
      dateLabel: YESTERDAY,
      spendRub: 790,
      clicks: 17,
      impressions: 280,
      leadsTotal: 1,
      leadsFromDirect: 1,
      costPerLeadRub: 790,
      quarantine: false,
    })
    expect(res.reportData?.ctr).toBeCloseTo((17 / 280) * 100, 5)
    expect(res.reportData?.topQueries[0]).toMatchObject({ query: 'доставка обедов в офис', clicks: 10 })

    // Итоги дня легли снапшотом daily_totals (для аномалий завтрашнего «сбора»).
    const totalsSnap = mockPrisma.borisDirectSnapshot.create.mock.calls.find(
      (c) => c[0].data.kind === 'daily_totals'
    )
    expect(totalsSnap?.[0].data.payload).toMatchObject({ date: YESTERDAY, spendRub: 790 })
  })

  it('OBSERVE: гейт вернул applied=false → всё в «сделал бы», ничего в applied', async () => {
    setupProcessHappyPath()
    setState({ mode: 'OBSERVE' })
    mockGate.applyNegativeKeywords.mockResolvedValue({ applied: false, logId: 'n1' })
    mockGate.applyBidChanges.mockResolvedValue({ applied: false, logId: 'b1', clamped: 0, breakerTripped: false })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    expect(res.appliedSummaries).toHaveLength(0)
    expect(res.wouldDoSummaries).toHaveLength(2)
    // Гейт всё равно вызывался (лог «сделал бы» пишет он сам).
    expect(mockGate.applyNegativeKeywords).toHaveBeenCalledTimes(1)
    expect(mockGate.applyBidChanges).toHaveBeenCalledTimes(1)
  })

  it('мусорный ответ LLM → ВСЕ кандидаты спорные, автономных минусов нет', async () => {
    setupProcessHappyPath()
    mockLlm.mockResolvedValue({ text: 'не могу, я всего лишь модель', model: 'haiku', costUsd: 0, downgraded: false })

    const res = await runProcessTick(NOW)

    expect(mockGate.applyNegativeKeywords).not.toHaveBeenCalled()
    expect(res.proposalDrafts).toHaveLength(1)
    expect((res.proposalDrafts[0].payload as { phrases: string[] }).phrases).toEqual([
      'чужое кафе вакансии',
      'корпоративное питание тендер',
    ])
  })

  it('autoNegativesEnabled (гейт снят обучением) → спорные тоже автономно, предложения нет', async () => {
    setupProcessHappyPath()
    setState({ mode: 'LIVE', autoNegativesEnabled: true })

    const res = await runProcessTick(NOW)

    expect(mockGate.applyNegativeKeywords).toHaveBeenCalledWith(
      ['чужое кафе вакансии', 'корпоративное питание тендер'],
      [],
      expect.any(String)
    )
    expect(res.proposalDrafts).toHaveLength(0)
  })

  it('circuit breaker на ставках → critical-аномалия, не в applied', async () => {
    setupProcessHappyPath()
    mockGate.applyBidChanges.mockResolvedValue({ applied: false, logId: 'b1', clamped: 0, breakerTripped: true })

    const res = await runProcessTick(NOW)

    expect(res.anomalies).toContainEqual(
      expect.objectContaining({ severity: 'critical', kind: 'circuit_breaker' })
    )
    expect(res.appliedSummaries).toEqual(
      expect.not.arrayContaining([expect.stringContaining('ставки')])
    )
  })

  it('ошибка одного блока не роняет тик: минусовка упала → ставки всё равно отработали', async () => {
    setupProcessHappyPath()
    mockLlm.mockRejectedValue(new Error('Anthropic 529'))
    // LLM упал → classified пуст → кандидаты спорные → предложение вместо автономии.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    expect(mockGate.applyNegativeKeywords).not.toHaveBeenCalled()
    expect(res.proposalDrafts).toHaveLength(1)
    expect(mockGate.applyBidChanges).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })
})
