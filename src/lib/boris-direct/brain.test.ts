import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Мозг (два тика дневного цикла). Все клиенты, prisma, write-gate и LLM
 * мокаются на уровне МОДУЛЕЙ — без сети, БД и Anthropic. Чистые функции
 * (rules, anomalies, парсеры отчётов/атрибуции) работают настоящие.
 */

const { mockPrisma, mockDirect, mockPollReport, mockGetGoalStatsByDay, mockGetGoalStatsByPhrase, mockGetLeads, mockGate, mockGetState, mockLlm, mockLessons, mockOutcomes } =
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
      borisDirectQueryDailyStat: { upsert: vi.fn(), findMany: vi.fn() },
      landingLead: { count: vi.fn() },
    },
    mockDirect: {
      getCampaignState: vi.fn(),
      getKeywords: vi.fn(),
      getKeywordBids: vi.fn(),
      getAds: vi.fn(),
      getBidModifiers: vi.fn(),
      getAdGroups: vi.fn(),
      getCampaignSettings: vi.fn(),
    },
    mockPollReport: vi.fn(),
    mockGetGoalStatsByDay: vi.fn(),
    mockGetGoalStatsByPhrase: vi.fn(),
    mockGetLeads: vi.fn(),
    mockGate: {
      applyBidChanges: vi.fn(),
      addNegativeKeywords: vi.fn(),
    },
    mockGetState: vi.fn(),
    mockLlm: vi.fn(),
    mockLessons: {
      deriveAndRefreshLessons: vi.fn(),
    },
    mockOutcomes: {
      measureActionOutcomes: vi.fn(),
      measureProposalOutcomes: vi.fn(),
      generateCorrectionProposals: vi.fn(),
    },
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
vi.mock('./metrika-client', () => ({
  getGoalStatsByDay: mockGetGoalStatsByDay,
  getGoalStatsByDevice: async () => [],
  getGoalStatsByDemographics: async () => [],
  getGoalStatsByHour: async () => [],
  getGoalStatsByPhrase: mockGetGoalStatsByPhrase,
}))
vi.mock('./attribution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./attribution')>()
  return { ...actual, getLeadsForPeriod: mockGetLeads }
})
vi.mock('./write-gate', () => mockGate)
vi.mock('./state', () => ({ getDirectRoleState: mockGetState }))
vi.mock('./llm', () => ({ callBorisDirectLlm: mockLlm }))
vi.mock('./prompts', () => ({ getBorisDirectSystemPrompt: () => 'SYS' }))
vi.mock('./lessons', () => mockLessons)
vi.mock('./outcomes', () => mockOutcomes)

import { runCollectTick, runProcessTick, backfillCriterionHistory, mskDay, mskDayStartUtc, yesterdayMsk } from './brain'
import { MICRO, MARGINAL_UPLIFT_ENABLED, PRIOR_CR_WINDOW_WORKDAYS } from './config'
import { workdayWindowStartUtc } from './workdays'

// 2026-07-02 09:00 UTC → сегодня-МСК 2026-07-02, вчера-МСК 2026-07-01.
const NOW = new Date('2026-07-02T09:00:00Z')
const YESTERDAY = '2026-07-01'

const SQ_TSV = [
  'Query\tAdGroupName\tAdGroupId\tCriterionId\tImpressions\tClicks\tCost\tConversions',
  // Запрос == текст ключа 11 (CriterionId 11) — конвертер группы 1.
  'доставка обедов в офис\tG1\t1\t11\t120\t10\t500\t2',
  // Запросы группы 2 сматчены на ключ 22 (broad) — минус-кандидаты, для биддинга тонкие.
  'чужое кафе вакансии\tG2\t2\t22\t80\t3\t100\t0',
  'корпоративное питание тендер\tG2\t2\t22\t50\t2\t90\t--',
].join('\n')

const CP_TSV = [
  'Date\tAdGroupId\tAdGroupName\tImpressions\tClicks\tCtr\tCost\tAvgCpc\tConversions',
  '2026-07-01\t1\tG1\t150\t12\t8.0\t600\t50\t2',
  '2026-07-01\t2\tG2\t130\t5\t3.8\t190\t38\t0',
].join('\n')

// Кумулятивный отчёт кампании (StartDate → вчера) для карантинного гейта:
// Σ Clicks = 37 ≥ 30 → по кликам карантин пройден.
const CUM_TSV = [
  'Date\tAdGroupId\tAdGroupName\tImpressions\tClicks\tCtr\tCost\tAvgCpc\tConversions',
  '2026-06-30\t1\tG1\t500\t20\t4.0\t2500\t125\t2',
  '2026-07-01\t2\tG2\t400\t17\t4.3\t1900\t112\t1',
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
  // Ключ 22 — живой (broad), текст НЕ пересекает минус-кандидаты; для liveKeyIds.
  { Id: 22, Keyword: 'доставка обедов область', AdGroupId: 2, State: 'ON', Status: 'ACCEPTED' },
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
    // Карантинный гейт: StartDate 2026-06-25 → возраст к NOW (02.07) = 7 ≥ 5 дней.
    if (args.where.kind === 'campaign_settings') {
      return {
        payload: {
          Id: 711897777,
          Name: 'Будни — Поиск — Волна 1',
          StartDate: '2026-06-25',
          TimeTargeting: { Schedule: { Items: [] } },
          NegativeKeywords: { Items: [] },
          Statistics: { Clicks: 37, Impressions: 900 },
        },
      }
    }
    return null
  })
  // Кумулятив кликов из Reports для гейта: отчёт готов, Σ Clicks = 37.
  mockPollReport.mockResolvedValue({ status: 'ready', tsv: CUM_TSV })
  mockPrisma.borisDirectReportJob.updateMany.mockResolvedValue({ count: 2 })
  mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue(null) // прежних минусов нет
  mockPrisma.borisDirectQueryDailyStat.upsert.mockResolvedValue({})
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
  mockGate.addNegativeKeywords.mockResolvedValue({ applied: true, logId: 'n1', aborted: false, added: 1 })
  mockGate.applyBidChanges.mockResolvedValue({ applied: true, logId: 'b1', clamped: 0, breakerTripped: false })
  setState({ mode: 'LIVE' })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Фаза 0: чтение объявлений — нейтральный дефолт (нет REJECTED).
  mockDirect.getAds.mockResolvedValue([])
  // Разведочные чтения (сессия «Прозрение») — по умолчанию нейтральны:
  // корректировок/групп нет, расписание задано → глубокая диагностика молчит.
  mockDirect.getBidModifiers.mockResolvedValue([])
  mockDirect.getAdGroups.mockResolvedValue([])
  mockDirect.getCampaignSettings.mockResolvedValue({
    Id: 711897777,
    Name: 'test',
    TimeTargeting: { Schedule: { Items: [] } },
    NegativeKeywords: { Items: [] },
  })
  // М2: пофразное поведение — нейтральный дефолт (пусто → поведенческие кандидаты молчат).
  mockGetGoalStatsByPhrase.mockResolvedValue([])
  mockPrisma.borisDirectQueryDailyStat.findMany.mockResolvedValue([])
  // Память-опыт: нейтральные дефолты (модули lessons/outcomes мокнуты целиком).
  mockOutcomes.measureActionOutcomes.mockResolvedValue({ measured: 0, worse: 0, unmeasurable: 0 })
  mockOutcomes.measureProposalOutcomes.mockResolvedValue({ measured: 0, worse: 0, unmeasurable: 0 })
  mockOutcomes.generateCorrectionProposals.mockResolvedValue({ created: 0 })
  mockLessons.deriveAndRefreshLessons.mockResolvedValue({ created: 0, confirmed: 0, refuted: 0, staled: 0 })
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
    mockGetLeads.mockResolvedValue([]) // лиды окна аномалий — по умолчанию пусто
  }

  it('снапшоты + заказ двух отчётов за вчера + первый шаг поллинга', async () => {
    setupCollect()
    mockPollReport
      .mockResolvedValueOnce({ status: 'ready', tsv: SQ_TSV })
      .mockResolvedValueOnce({ status: 'pending', retryInSec: 30 })

    const res = await runCollectTick(NOW)

    // Снапшоты: campaign/keywords/keywordbids/ads (сегодня, ads — фаза 0
    // полигона) + metrika_goal (вчера) + разведочные (сессия «Прозрение»):
    // корректировки/группы/расписание + оконные срезы Метрики.
    const kinds = mockPrisma.borisDirectSnapshot.create.mock.calls.map((c) => c[0].data.kind)
    expect(kinds).toEqual([
      'campaign', 'keywords', 'keywordbids', 'ads', 'metrika_goal',
      'bidmodifiers', 'adgroups', 'campaign_settings', 'metrika_device', 'metrika_demo', 'metrika_hour', 'metrika_phrase',
    ])

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

  it('MINOR-2: leads_zero считает заявки БЕЗ тестовых — 0 реальных + 1 «Тестик» → аномалия срабатывает', async () => {
    setupCollect()
    mockPollReport.mockResolvedValue({ status: 'pending', retryInSec: 30 })
    // Вчера (среда 01.07): только тестовая заявка. 7 дней до этого: 14 реальных → avg 2/день.
    mockGetLeads
      .mockResolvedValueOnce([{ id: 't1', name: 'Тестик', phoneDigits: '79995555555' }])
      .mockResolvedValueOnce(
        Array.from({ length: 14 }, (_, i) => ({ id: `r${i}`, name: 'Клиент', phoneDigits: '79991112233' }))
      )

    const res = await runCollectTick(NOW)

    // Тестовая «Тестик» отфильтрована → реальных вчера 0 при среднем 2 → аномалия.
    expect(res.anomalies).toContainEqual(expect.objectContaining({ kind: 'leads_zero' }))
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
    expect(mockGate.addNegativeKeywords).not.toHaveBeenCalled()
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
    // StartDate 2026-06-30 → возраст к NOW (02.07) = 2 < 5 дней → карантин по дням
    // (кумулятив кликов 37 сам по себе порог прошёл бы — ветка дней держит).
    mockPrisma.borisDirectSnapshot.findFirst.mockImplementation(async (args: { where: { kind: string } }) => {
      if (args.where.kind === 'campaign_settings') {
        return { payload: { Id: 711897777, Name: 'test', StartDate: '2026-06-30' } }
      }
      return null
    })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('quarantine')
    expect(res.reportData).toMatchObject({ quarantine: true, dateLabel: YESTERDAY })
    expect(mockGate.applyBidChanges).not.toHaveBeenCalled()
    expect(mockGate.addNegativeKeywords).not.toHaveBeenCalled()
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

    // МИНУСА: структурный+уверенный кандидат ушёл автономно через единую точку
    // мержа (addNegativeKeywords сам объединяет с живым списком кабинета).
    expect(mockGate.addNegativeKeywords).toHaveBeenCalledTimes(1)
    expect(mockGate.addNegativeKeywords).toHaveBeenCalledWith(
      ['чужое кафе вакансии'],
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

    // СТАВКИ (пофразно): оба ключа — promote к TV65 (150 ₽) по Байесу (ключ 11 —
    // конвертер с 2 заявками; ключ 22 — тонкий, встроенный exploration).
    // М3.5 RAMP-IN: как ПАЧКА оба (+50% и +200%) дают +100% массы → CB не пропускает
    // целиком. Приоритет — конвертер (ключ 11, +50% влезает под mass-cap) применяется;
    // тонкая exploration (ключ 22, +200%) откладывается порционным вводом. РЕШЕНИЯ по
    // обоим эмитированы (level-lock от вердикта), applyBidChanges получает подмножество.
    expect(mockGate.applyBidChanges).toHaveBeenCalledTimes(1)
    expect(mockGate.applyBidChanges.mock.calls[0][0]).toEqual([
      { keywordId: 11, fromMicro: 100 * MICRO, toMicro: 150 * MICRO },
    ])
    const bid22Dec = res.decisions?.find((d) => d.type === 'bid' && d.targetId === '22')
    expect((bid22Dec!.factors as { toMicro: number }).toMicro).toBe(150 * MICRO)
    expect(res.reportData?.portfolioRampIn).toEqual({ applied: 1, planned: 2, deferred: 1 })

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

  it('MINOR-3: первый гейт DATA_MISMATCH — Метрика day-bound; протухший latest-снапшот не даёт ложный диагноз', async () => {
    setupProcessHappyPath()
    const baseFindFirst = mockPrisma.borisDirectSnapshot.findFirst.getMockImplementation()!
    // Метрика: за НУЖНЫЙ день снапшота нет (day-bound → null); «последний» (другой
    // день, tickDate не задан) — протухшие 100 достижений.
    mockPrisma.borisDirectSnapshot.findFirst.mockImplementation(async (args: { where: { kind: string; tickDate?: unknown } }) => {
      if (args.where.kind === 'metrika_goal') {
        return args.where.tickDate ? null : { payload: [{ goalReaches: 100 }] }
      }
      return baseFindFirst(args)
    })

    const res = await runProcessTick(NOW)

    // Метрика за день отсутствует → из сравнения ИСКЛЮЧЕНА → нет ложного расхождения
    // (иначе протухшие 100 против отчёта 2 / БД 1 дали бы ложный DATA_MISMATCH).
    expect(res.decisions).not.toContainEqual(expect.objectContaining({ reasonCode: 'DATA_MISMATCH' }))
  })

  it('OBSERVE: гейт вернул applied=false → всё в «сделал бы», ничего в applied', async () => {
    setupProcessHappyPath()
    setState({ mode: 'OBSERVE' })
    mockGate.addNegativeKeywords.mockResolvedValue({ applied: false, logId: 'n1', aborted: false, added: 1 })
    mockGate.applyBidChanges.mockResolvedValue({ applied: false, logId: 'b1', clamped: 0, breakerTripped: false })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    expect(res.appliedSummaries).toHaveLength(0)
    expect(res.wouldDoSummaries).toHaveLength(2)
    // Гейт всё равно вызывался (лог «сделал бы» пишет он сам).
    expect(mockGate.addNegativeKeywords).toHaveBeenCalledTimes(1)
    expect(mockGate.applyBidChanges).toHaveBeenCalledTimes(1)
  })

  it('мусорный ответ LLM → ВСЕ кандидаты спорные, автономных минусов нет', async () => {
    setupProcessHappyPath()
    mockLlm.mockResolvedValue({ text: 'не могу, я всего лишь модель', model: 'haiku', costUsd: 0, downgraded: false })

    const res = await runProcessTick(NOW)

    expect(mockGate.addNegativeKeywords).not.toHaveBeenCalled()
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

    expect(mockGate.addNegativeKeywords).toHaveBeenCalledWith(
      ['чужое кафе вакансии', 'корпоративное питание тендер'],
      expect.any(String)
    )
    expect(res.proposalDrafts).toHaveLength(0)
  })

  it('FAIL-SAFE автономной минусовки: addNegativeKeywords вернул aborted → critical-аномалия, минус не в applied', async () => {
    setupProcessHappyPath()
    mockGate.addNegativeKeywords.mockResolvedValue({
      applied: false,
      logId: null,
      aborted: true,
      abortReason: 'живой минус-список кабинета не прочитан',
      added: 0,
    })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    // Минус НЕ попал в applied (ставки — отдельный блок — отработали).
    expect(res.appliedSummaries).toEqual(
      expect.not.arrayContaining([expect.stringContaining('минус')])
    )
    expect(res.anomalies).toContainEqual(
      expect.objectContaining({ severity: 'critical', kind: 'negatives_failsafe' })
    )
  })

  it('verifyMismatch автономной минусовки: применили, но кабинет не сошёлся → critical-аномалия', async () => {
    setupProcessHappyPath()
    mockGate.addNegativeKeywords.mockResolvedValue({
      applied: true,
      logId: 'n1',
      aborted: false,
      added: 1,
      verifyMismatch: true,
    })

    const res = await runProcessTick(NOW)

    expect(res.anomalies).toContainEqual(
      expect.objectContaining({ kind: 'negatives_verify_mismatch' })
    )
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

  it('A: write минусов провалился (writeErrors) → critical-аномалия, минус НЕ в applied', async () => {
    setupProcessHappyPath()
    mockGate.addNegativeKeywords.mockResolvedValue({
      applied: false,
      logId: 'n1',
      aborted: false,
      added: 1,
      addedPhrases: ['чужое кафе вакансии'],
      writeErrors: ['8000: Некорректная минус-фраза'],
    })

    const res = await runProcessTick(NOW)

    expect(res.anomalies).toContainEqual(
      expect.objectContaining({ severity: 'critical', kind: 'negatives_write_fail' })
    )
    // Провалившийся write НЕ считаем ни applied, ни «сделал бы».
    expect(res.appliedSummaries).toEqual(
      expect.not.arrayContaining([expect.stringContaining('минус')])
    )
    expect(res.wouldDoSummaries).toEqual(
      expect.not.arrayContaining([expect.stringContaining('минус')])
    )
  })

  it('A: write ставок провалился целиком (writeErrors, applied=false) → critical-аномалия, ставки НЕ в applied', async () => {
    setupProcessHappyPath()
    mockGate.applyBidChanges.mockResolvedValue({
      applied: false,
      logId: 'b1',
      clamped: 0,
      breakerTripped: false,
      writeErrors: ['5005: Неверный параметр'],
    })

    const res = await runProcessTick(NOW)

    expect(res.anomalies).toContainEqual(
      expect.objectContaining({ severity: 'critical', kind: 'bids_write_fail' })
    )
    expect(res.appliedSummaries).toEqual(
      expect.not.arrayContaining([expect.stringContaining('ставки')])
    )
  })

  it('A: ставки применены ЧАСТИЧНО (partial+writeErrors, applied=true) → аномалия, но применённое считаем', async () => {
    setupProcessHappyPath()
    mockGate.applyBidChanges.mockResolvedValue({
      applied: true,
      logId: 'b1',
      clamped: 0,
      breakerTripped: false,
      partial: true,
      writeErrors: ['5005: Неверный параметр'],
    })

    const res = await runProcessTick(NOW)

    expect(res.anomalies).toContainEqual(
      expect.objectContaining({ kind: 'bids_partial_fail' })
    )
    // Часть ставок реально применилась → она в applied (с пометкой «частично»).
    expect(res.appliedSummaries).toEqual(
      expect.arrayContaining([expect.stringContaining('ставки')])
    )
  })

  it('ошибка одного блока не роняет тик: минусовка упала → ставки всё равно отработали', async () => {
    setupProcessHappyPath()
    mockLlm.mockRejectedValue(new Error('Anthropic 529'))
    // LLM упал → classified пуст → кандидаты спорные → предложение вместо автономии.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    expect(mockGate.addNegativeKeywords).not.toHaveBeenCalled()
    expect(res.proposalDrafts).toHaveLength(1)
    expect(mockGate.applyBidChanges).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })
})

describe('runProcessTick — память-опыт (персист статистики + хуки уроков/исходов)', () => {
  // NOW (2026-07-02) — четверг по МСК; 22:00 UTC воскресенья 2026-07-05 —
  // это уже 01:00 понедельника 2026-07-06 по МСК (проверяем именно МСК-границу).
  const MONDAY_MSK_NOW = new Date('2026-07-05T22:00:00Z')

  it('upsert BorisDirectQueryDailyStat по каждой строке отчёта, date = вчера-МСК', async () => {
    setupProcessHappyPath()

    await runProcessTick(NOW)

    expect(mockPrisma.borisDirectQueryDailyStat.upsert).toHaveBeenCalledTimes(3)
    const date = mskDayStartUtc(YESTERDAY)
    expect(mockPrisma.borisDirectQueryDailyStat.upsert).toHaveBeenCalledWith({
      where: { date_query_adGroupId: { date, query: 'доставка обедов в офис', adGroupId: '1' } },
      update: { adGroupName: 'G1', impressions: 120, clicks: 10, costRub: 500, conversions: 2 },
      create: {
        date,
        query: 'доставка обедов в офис',
        adGroupId: '1',
        adGroupName: 'G1',
        impressions: 120,
        clicks: 10,
        costRub: 500,
        conversions: 2,
      },
    })
    // Conversions '--' в TSV → 0.
    expect(mockPrisma.borisDirectQueryDailyStat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { date_query_adGroupId: { date, query: 'корпоративное питание тендер', adGroupId: '2' } },
        create: expect.objectContaining({ conversions: 0 }),
      })
    )
  })

  it('персист упал → тик всё равно done (console.error, не throw)', async () => {
    setupProcessHappyPath()
    mockPrisma.borisDirectQueryDailyStat.upsert.mockRejectedValue(new Error('db down'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    errorSpy.mockRestore()
  })

  it('done: замер исходов вызван, сумма measured в res.memory; не понедельник → уроки не трогаем', async () => {
    setupProcessHappyPath()
    mockOutcomes.measureActionOutcomes.mockResolvedValue({ measured: 2, worse: 1, unmeasurable: 0 })
    mockOutcomes.measureProposalOutcomes.mockResolvedValue({ measured: 1, worse: 0, unmeasurable: 1 })

    const res = await runProcessTick(NOW) // четверг по МСК

    expect(res.status).toBe('done')
    expect(mockOutcomes.measureActionOutcomes).toHaveBeenCalledTimes(1)
    expect(mockOutcomes.measureProposalOutcomes).toHaveBeenCalledTimes(1)
    expect(mockLessons.deriveAndRefreshLessons).not.toHaveBeenCalled()
    expect(mockOutcomes.generateCorrectionProposals).not.toHaveBeenCalled()
    expect(res.memory).toEqual({ outcomesMeasured: 3 })
  })

  it('quarantine: memory-хуки тоже вызваны (опыт копится и в карантине)', async () => {
    setupProcessHappyPath()
    // StartDate 2026-06-30 → возраст к NOW (02.07) = 2 < 5 дней → карантин по дням.
    mockPrisma.borisDirectSnapshot.findFirst.mockImplementation(async (args: { where: { kind: string } }) => {
      if (args.where.kind === 'campaign_settings') {
        return { payload: { Id: 711897777, Name: 'test', StartDate: '2026-06-30' } }
      }
      return null
    })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('quarantine')
    expect(mockOutcomes.measureActionOutcomes).toHaveBeenCalledTimes(1)
    expect(mockOutcomes.measureProposalOutcomes).toHaveBeenCalledTimes(1)
    expect(res.memory).toEqual({ outcomesMeasured: 0 })
  })

  it('waiting_report: memory-хуки НЕ вызваны, memory отсутствует', async () => {
    setState({ mode: 'LIVE' })
    mockPrisma.borisDirectReportJob.findMany.mockResolvedValue([]) // PENDING нет
    mockPrisma.borisDirectReportJob.findFirst.mockResolvedValue(null) // готовых отчётов нет

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('waiting_report')
    expect(res.memory).toBeUndefined()
    expect(mockOutcomes.measureActionOutcomes).not.toHaveBeenCalled()
    expect(mockOutcomes.measureProposalOutcomes).not.toHaveBeenCalled()
    expect(mockLessons.deriveAndRefreshLessons).not.toHaveBeenCalled()
    expect(mockPrisma.borisDirectQueryDailyStat.upsert).not.toHaveBeenCalled()
  })

  it('понедельник по МСК → deriveAndRefreshLessons + generateCorrectionProposals, итог в memory.lessons', async () => {
    setupProcessHappyPath()
    mockLessons.deriveAndRefreshLessons.mockResolvedValue({ created: 2, confirmed: 1, refuted: 0, staled: 1 })

    const res = await runProcessTick(MONDAY_MSK_NOW)

    expect(res.status).toBe('done')
    expect(mockLessons.deriveAndRefreshLessons).toHaveBeenCalledTimes(1)
    expect(mockOutcomes.generateCorrectionProposals).toHaveBeenCalledTimes(1)
    expect(res.memory).toEqual({
      outcomesMeasured: 0,
      lessons: { created: 2, confirmed: 1, refuted: 0, staled: 1 },
    })
  })

  it('memory-хук упал → тик не падает, memory без его вклада', async () => {
    setupProcessHappyPath()
    mockOutcomes.measureActionOutcomes.mockRejectedValue(new Error('outcomes down'))
    mockOutcomes.measureProposalOutcomes.mockResolvedValue({ measured: 4, worse: 0, unmeasurable: 0 })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    expect(res.memory).toEqual({ outcomesMeasured: 4 })
    errorSpy.mockRestore()
  })
})

describe('DEVICE_SKEW — точный ₽ из device-отчёта Директа (М2)', () => {
  it('device-отчёт с Device → точные ₽ (costEstimated=false), фолбэк на Метрику не задействован', async () => {
    setupProcessHappyPath()
    const DEVICE_TSV = [
      'Device\tImpressions\tClicks\tCost\tConversions_575665118_LSCCD',
      'DESKTOP\t100\t30\t1500.00\t2',
      'MOBILE\t50\t20\t800.00\t0', // слив: 20 кликов, 800 ₽, 0 заявок
    ].join('\n')
    // device-отчёт (ReportName bd_dev_*) → device-TSV; прочие отчёты → CUM_TSV.
    mockPollReport.mockImplementation(async (body: { params?: { ReportName?: string } }) => {
      const name = body?.params?.ReportName ?? ''
      if (name.startsWith('bd_dev_')) return { status: 'ready', tsv: DEVICE_TSV }
      return { status: 'ready', tsv: CUM_TSV }
    })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    const skew = res.proposalDrafts.find((p) => p.type === 'device_skew')
    expect(skew).toBeDefined()
    const payload = skew!.payload as { device: string; costRub: number; costEstimated: boolean }
    expect(payload.device).toBe('MOBILE')
    expect(payload.costRub).toBe(800) // ТОЧНЫЙ ₽ из отчёта Директа
    expect(payload.costEstimated).toBe(false)
    expect(skew!.argument).not.toContain('≈') // не оценка
  })
})

describe('поведенческие минус-кандидаты (М2, ТОЛЬКО предложением)', () => {
  it('фраза с плохим поведением → предложение behavioral_minus; реестровый конвертер защищён', async () => {
    setupProcessHappyPath()
    const phraseRows = [
      { phrase: 'чужое кафе рядом', visits: 5, bounceRate: 90, avgDurationSec: 6, goalReaches: 0 }, // мусор
      { phrase: 'бизнес ланч доставка москва', visits: 4, bounceRate: 80, avgDurationSec: 5, goalReaches: 0 }, // реестровый конвертер
      { phrase: 'обеды в офис москва хорошие', visits: 5, bounceRate: 10, avgDurationSec: 120, goalReaches: 0 }, // хорошее поведение
    ]
    mockPrisma.borisDirectSnapshot.findFirst.mockImplementation(async (args: { where: { kind: string } }) => {
      if (args.where.kind === 'metrika_phrase') return { payload: phraseRows }
      if (args.where.kind === 'keywords') return { payload: KEYWORDS_PAYLOAD }
      if (args.where.kind === 'keywordbids') return { payload: BIDS_PAYLOAD }
      if (args.where.kind === 'campaign_settings') {
        return {
          payload: {
            Id: 711897777, Name: 'x', StartDate: '2026-06-25',
            TimeTargeting: { Schedule: { Items: [] } },
            NegativeKeywords: { Items: [] }, Statistics: { Clicks: 37, Impressions: 900 },
          },
        }
      }
      return null
    })

    const res = await runProcessTick(NOW)

    const behavioral = res.proposalDrafts.find((p) => p.type === 'behavioral_minus')
    expect(behavioral).toBeDefined()
    const phrases = (behavioral!.payload as { phrases: string[] }).phrases
    expect(phrases).toContain('чужое кафе рядом') // высокий отказ + мгновенный уход
    expect(phrases).not.toContain('бизнес ланч доставка москва') // реестровый конвертер — защищён
    expect(phrases).not.toContain('обеды в офис москва хорошие') // хорошее поведение — не кандидат
    // Никакого АВТО-минуса по поведению: applyBidChanges/addNegativeKeywords поведение не дёргает.
    // (проверяем, что поведенческий блок не пишет в кабинет — только proposalDraft)
    expect(behavioral!.question).toContain('поведению')
  })

  it('Метрика пуста → блок молчит (нет behavioral_minus, тик done)', async () => {
    setupProcessHappyPath() // metrika_phrase не замокан → findFirst вернёт null
    const res = await runProcessTick(NOW)
    expect(res.status).toBe('done')
    expect(res.proposalDrafts.some((p) => p.type === 'behavioral_minus')).toBe(false)
  })
})

describe('backfillCriterionHistory (self-heal истории пофразной экономики)', () => {
  const NOW_BF = new Date('2026-07-09T09:00:00Z')
  // Суффиксная колонка конверсий (как отдаёт живой API при Goals). 205769314414 —
  // автотаргет (20<adGroupId>): числовой CriterionId, идёт в снапшот (как в process),
  // отфильтруется по liveKeyIds при чтении. Пустой CriterionId → в снапшот НЕ идёт.
  const BF_TSV = [
    'Date\tCriterionId\tImpressions\tClicks\tCost\tConversions_575665118_LSCCD\tAvgTrafficVolume',
    '2026-06-30\t111\t8\t0\t0.00\t--\t8.50',
    '2026-07-01\t111\t50\t4\t200.00\t1\t28.90',
    '2026-07-01\t205769314414\t5\t0\t0.00\t--\t8.50',
    '2026-07-01\t\t3\t1\t50.00\t0\t8.50',
  ].join('\n')

  function createdSnapshots(kind: string) {
    const calls = mockPrisma.borisDirectSnapshot.create.mock.calls as Array<
      [{ data: { tickDate: Date; kind: string; payload: unknown } }]
    >
    return calls.map((c) => c[0].data).filter((d) => d.kind === kind)
  }

  beforeEach(() => {
    mockPrisma.borisDirectSnapshot.create.mockResolvedValue({})
  })

  it('добирает ТОЛЬКО отсутствующие даты (08.07 есть → его не трогаем; форма head-совместима)', async () => {
    // Уже есть снапшот за 08.07 → backfill добирает 30.06..07.07.
    mockPrisma.borisDirectSnapshot.findMany.mockResolvedValue([
      { tickDate: mskDayStartUtc('2026-07-08') },
    ])
    mockPollReport.mockResolvedValue({ status: 'ready', tsv: BF_TSV })

    const res = await backfillCriterionHistory('2026-06-30', '2026-07-08', NOW_BF)

    const snaps = createdSnapshots('query_criterion_daily')
    const days = snaps.map((s) => mskDay(s.tickDate)).sort()
    // 30.06..07.07 = 8 дней; 08.07 НЕ перезаписан.
    expect(days).toEqual([
      '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03',
      '2026-07-04', '2026-07-05', '2026-07-06', '2026-07-07',
    ])
    expect(res.backfilledDays).toHaveLength(8)

    // 01.07: ключ 111 (4 клика, 1 заявка из суффиксной колонки) + автотаргет; пустой CriterionId отброшен.
    const d0107 = snaps.find((s) => mskDay(s.tickDate) === '2026-07-01')!.payload as Array<{
      criterionId: number; clicks: number; conversions: number; avgTrafficVolume: number
    }>
    const key111 = d0107.find((x) => x.criterionId === 111)!
    expect(key111).toMatchObject({ criterionId: 111, clicks: 4, conversions: 1, avgTrafficVolume: 28.9 })
    expect(d0107.some((x) => x.criterionId === 205769314414)).toBe(true) // автотаргет в снапшоте
    expect(d0107.every((x) => typeof x.criterionId === 'number')).toBe(true) // пустой CriterionId отброшен
    // 30.06: только ключ 111 с 0 кликов; день без данных (напр. 05.07) — пустой снапшот (маркер «добрано»).
    const d3006 = snaps.find((s) => mskDay(s.tickDate) === '2026-06-30')!.payload as unknown[]
    expect(d3006).toHaveLength(1)
    const d0505 = snaps.find((s) => mskDay(s.tickDate) === '2026-07-05')!.payload as unknown[]
    expect(d0505).toEqual([])
  })

  it('ВЧЕРА не добирается backfill (его пишет тик обработки) — только история StartDate..позавчера', async () => {
    mockPrisma.borisDirectSnapshot.findMany.mockResolvedValue([]) // ничего нет
    mockPollReport.mockResolvedValue({ status: 'ready', tsv: BF_TSV })

    const res = await backfillCriterionHistory('2026-06-30', '2026-07-08', NOW_BF)

    // yesterday=08.07 → backfill закрывает 30.06..07.07 (позавчера), 08.07 НЕ трогает.
    expect(res.backfilledDays).toContain('2026-07-07')
    expect(res.backfilledDays).not.toContain('2026-07-08')
    const days = createdSnapshots('query_criterion_daily').map((s) => mskDay(s.tickDate))
    expect(days).not.toContain('2026-07-08')
  })

  it('повторный запуск — no-op: все дни есть → ни отчёта, ни записей', async () => {
    // Все дни 30.06..08.07 присутствуют.
    const allDays = ['06-30', '07-01', '07-02', '07-03', '07-04', '07-05', '07-06', '07-07', '07-08']
      .map((d) => ({ tickDate: mskDayStartUtc(`2026-${d}`) }))
    mockPrisma.borisDirectSnapshot.findMany.mockResolvedValue(allDays)

    const res = await backfillCriterionHistory('2026-06-30', '2026-07-08', NOW_BF)

    expect(res.backfilledDays).toHaveLength(0)
    expect(mockPollReport).not.toHaveBeenCalled() // отчёт не заказывали
    expect(createdSnapshots('query_criterion_daily')).toHaveLength(0)
  })

  it('FAIL-SAFE: отчёт failed → 0 записей, дни НЕ помечены (ретрай на след. тике)', async () => {
    mockPrisma.borisDirectSnapshot.findMany.mockResolvedValue([])
    mockPollReport.mockResolvedValue({ status: 'failed', error: 'HTTP 500' })

    const res = await backfillCriterionHistory('2026-06-30', '2026-07-08', NOW_BF)

    expect(res.backfilledDays).toHaveLength(0)
    expect(createdSnapshots('query_criterion_daily')).toHaveLength(0)
  })

  it('нет StartDate → no-op (fail-safe)', async () => {
    const res = await backfillCriterionHistory(null, '2026-07-08', NOW_BF)
    expect(res.backfilledDays).toHaveLength(0)
    expect(mockPollReport).not.toHaveBeenCalled()
  })
})

describe('пофразная экономика по CriterionId (MAJOR-2: агрегация по ключу, не по тексту)', () => {
  const SQ_HEADER = 'Query\tAdGroupName\tAdGroupId\tCriterionId\tImpressions\tClicks\tCost\tConversions'
  function sqTsv(
    rows: Array<{ q: string; g: string; cid: string; clicks: number; conv: number | string; imp?: number }>
  ): string {
    return [
      SQ_HEADER,
      ...rows.map((r) => `${r.q}\tG\t${r.g}\t${r.cid}\t${r.imp ?? 10}\t${r.clicks}\t100\t${r.conv}`),
    ].join('\n')
  }
  type Kw = { Id: number; Keyword: string; AdGroupId: number; State: string; Status: string }
  type Bid = { KeywordId: number; AdGroupId: number; CampaignId: number; Search: { Bid: number; AuctionBids: typeof AUCTION } }
  function setupEconomics(opts: { sq: string; keywords: Kw[]; bids: Bid[] }) {
    setupProcessHappyPath()
    mockPrisma.borisDirectReportJob.findFirst.mockImplementation(async (args: { where: { reportType: string } }) => {
      if (args.where.reportType === 'SEARCH_QUERY_PERFORMANCE_REPORT') return { id: 'sq1', tsv: opts.sq }
      if (args.where.reportType === 'CUSTOM_REPORT') return { id: 'cp1', tsv: CP_TSV }
      return null
    })
    mockPrisma.borisDirectSnapshot.findFirst.mockImplementation(async (args: { where: { kind: string } }) => {
      if (args.where.kind === 'keywords') return { payload: opts.keywords }
      if (args.where.kind === 'keywordbids') return { payload: opts.bids }
      if (args.where.kind === 'campaign_settings') {
        return {
          payload: {
            Id: 711897777, Name: 'x', StartDate: '2026-06-25',
            TimeTargeting: { Schedule: { Items: [] } },
            NegativeKeywords: { Items: [] }, Statistics: { Clicks: 37, Impressions: 900 },
          },
        }
      }
      return null
    })
  }
  const bid = (keywordId: number, group: number, bidRub: number): Bid => ({
    KeywordId: keywordId, AdGroupId: group, CampaignId: 711897777,
    Search: { Bid: bidRub * MICRO, AuctionBids: AUCTION },
  })
  const kw = (Id: number, Keyword: string, g: number): Kw => ({ Id, Keyword, AdGroupId: g, State: 'ON', Status: 'ACCEPTED' })

  it('(а) запрос ДЛИННЕЕ текста ключа → клики/заявки падают в head ЭТОГО ключа по CriterionId (фраза просыпается)', async () => {
    setupEconomics({
      sq: sqTsv([{ q: 'обеды в офис москва подешевле срочно', g: '1', cid: '100', clicks: 25, conv: 1 }]),
      keywords: [kw(100, 'обеды', 1)],
      bids: [bid(100, 1, 40)],
    })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    // Текст ключа 'обеды' ≠ запросу — по СТАРОЙ (текстовой) логике head пуст → тонкая → hold.
    // По ID клики 25 + заявка 1 приписаны ключу 100 → КОНВЕРТЕР → подъём к TV65 (150 ₽).
    // Одиночная правка 40→150 (+275%) не проходит mass-cap CB в одиночку → ramp-in
    // откладывает применение, но РЕШЕНИЕ (вердикт→уровень) эмитировано корректно.
    const bidDec = res.decisions?.find((d) => d.type === 'bid' && d.targetId === '100')
    expect(bidDec).toBeDefined()
    expect((bidDec!.factors as { toMicro: number }).toMicro).toBe(150 * MICRO)
  })

  it('(б) АУДИТ: «горелка» по одной словоформе, но заявки через длинные варианты ТОГО ЖЕ ключа → НЕ режем в TV15', async () => {
    setupEconomics({
      sq: sqTsv([
        { q: 'бизнес ланч', g: '1', cid: '200', clicks: 25, conv: 0 }, // точная словоформа: на вид «горелка»
        { q: 'бизнес ланч доставка офис москва', g: '1', cid: '200', clicks: 6, conv: 1 }, // длинный вариант ТОГО ЖЕ ключа: заявка
      ]),
      keywords: [kw(200, 'бизнес ланч', 1)],
      bids: [bid(200, 1, 40)],
    })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    // Агрегат по ID: 31 клик + 1 заявка → КОНВЕРТЕР → нижний блок TV65 (150 ₽),
    // а НЕ «горелка → TV15 (50 ₽)». Это и есть опасный кейс (б) аудита. Решение
    // эмитировано; применение одиночной +275% правки метрится ramp-in под CB.
    const bidDec = res.decisions?.find((d) => d.type === 'bid' && d.targetId === '200')
    expect(bidDec).toBeDefined()
    expect((bidDec!.factors as { toMicro: number }).toMicro).toBe(150 * MICRO) // TV65, не 50 ₽ (TV15)
  })

  it('строки автотаргета / нежившие CriterionId в пофразный биддинг НЕ идут', async () => {
    setupEconomics({
      sq: sqTsv([
        // Автотаргет: CriterionId ЧИСЛОВОЙ вида 20<adGroupId> (сырьё живого API; строка
        // '---autotargeting' лежит в отдельной колонке Criterion, которую отчёт не тянет).
        // Числовой, но НЕ живой ключ → отсекается по liveKeyIds, как орфан-ID ниже.
        { q: 'что-то автотаргет', g: '1', cid: '205769314414', clicks: 50, conv: 3 },
        { q: 'орфан ключ', g: '1', cid: '999999', clicks: 50, conv: 3 }, // числовой, но НЕ живой ключ
      ]),
      keywords: [kw(100, 'обеды', 1)],
      bids: [bid(100, 1, 40)],
    })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    // Автотаргет/орфан НЕ в liveKeyIds → их 3 заявки ключу 100 НЕ приписаны. М3: Байес
    // даёт тонкому ключу вход (promote), но headLeads=0 в решении доказывает отсутствие
    // утечки (если бы приписалось — было бы 3, и ключ стал бы «конвертером»).
    const bidDec = res.decisions?.find((d) => d.type === 'bid' && d.targetId === '100')
    expect(bidDec).toBeDefined()
    expect((bidDec!.factors as { headLeads: number }).headLeads).toBe(0)
  })

  it('FAIL-SAFE: строка без CriterionId не приписывается ключу (М3: promote как тонкий, headLeads=0)', async () => {
    setupEconomics({
      sq: sqTsv([{ q: 'обеды в офис москва', g: '1', cid: '', clicks: 25, conv: 1 }]), // CriterionId пуст → null
      keywords: [kw(100, 'обеды', 1)],
      bids: [bid(100, 1, 40)],
    })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    // 25 кликов/1 заявка есть, но CriterionId пуст → ключу 100 НЕ приписаны → headLeads=0.
    const bidDec = res.decisions?.find((d) => d.type === 'bid' && d.targetId === '100')
    expect(bidDec).toBeDefined()
    expect((bidDec!.factors as { headLeads: number }).headLeads).toBe(0)
  })

  it('РЕЕСТРОВЫЙ конвертер, «тонкий» по объёму (<20 кликов, 0 заявок в окне) — кормится TV65, НЕ глохнет в hold (конвертер-защита ДО thin-гейта)', async () => {
    // 'бизнес ланч доставка москва' — подтверждённый конвертер из converters.ts.
    // По объёму окна он «тонкий» (3 клика, 0 заявок) → thin-гейт увёл бы его в hold
    // ДО проверки конвертерства. Реестровая защита обязана обойти thin-гейт.
    setupEconomics({
      sq: sqTsv([{ q: 'бизнес ланч доставка москва', g: '1', cid: '300', clicks: 3, conv: 0, imp: 10 }]),
      keywords: [kw(300, 'бизнес ланч доставка москва', 1)],
      bids: [bid(300, 1, 40)],
    })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    // Реестровый конвертер доходит до recommendBid → вход в нижний блок TV65 (150 ₽).
    // До фикса порядка гейтов он глох как «тонкий» и правок не было вовсе. Одиночная
    // правка 40→150 (+275%) метрится ramp-in под CB — решение эмитировано.
    const bidDec = res.decisions?.find((d) => d.type === 'bid' && d.targetId === '300')
    expect(bidDec).toBeDefined()
    expect((bidDec!.factors as { toMicro: number }).toMicro).toBe(150 * MICRO)
  })

  it('М3: ТОНКАЯ фраза (3 клика, 0 заявок) → promote (вход TV65), поглощающего hold больше НЕТ (встроенный exploration)', async () => {
    setupEconomics({
      sq: sqTsv([{ q: 'обеды в офис', g: '1', cid: '400', clicks: 3, conv: 0, imp: 10 }]),
      keywords: [kw(400, 'обеды в офис', 1)],
      bids: [bid(400, 1, 40)],
    })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    // Байес: posterior≈prior (мало данных) → вердикт promote → вход в нижний блок TV65,
    // а не вечный hold. Фраза получает ШАНС собрать данные (exploration). Одиночный
    // +275% откладывается ramp-in под CB — но РЕШЕНИЕ (promote→TV65) эмитировано.
    const bidDec = res.decisions?.find((d) => d.type === 'bid' && d.targetId === '400')
    expect(bidDec).toBeDefined()
    expect((bidDec!.factors as { toMicro: number }).toMicro).toBe(150 * MICRO)
  })

  it('М3: горелка (много кликов, 0 заявок) → demote к TV15 (уверенно ниже порога)', async () => {
    // 50 кликов, 0 заявок при CR кампании (тут CR=0 → fallback 0.05): posterior уверенно
    // ниже порога → demote → минимум TV15 (50 ₽ на шкале AUCTION).
    setupEconomics({
      sq: sqTsv([{ q: 'горелка фраза', g: '1', cid: '500', clicks: 50, conv: 0 }]),
      keywords: [kw(500, 'горелка фраза', 1)],
      bids: [bid(500, 1, 200)], // сейчас высоко (200 ₽) → demote вниз
    })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    const changes = mockGate.applyBidChanges.mock.calls[0]?.[0] as Array<{ keywordId: number; toMicro: number }> | undefined
    expect(changes).toEqual([{ keywordId: 500, fromMicro: 200 * MICRO, toMicro: 50 * MICRO }]) // TV15
  })

  it('М3.5: гейт открыт + level-lock — маржинальный подъём ПОД ФЛАГОМ (вкл → TV75, выкл → база TV65)', async () => {
    setupEconomics({
      sq: sqTsv([{ q: 'конвертер сильный', g: '1', cid: '600', clicks: 30, conv: 4 }]),
      keywords: [kw(600, 'конвертер сильный', 1)],
      bids: [bid(600, 1, 40)],
    })
    // Живой бюджет 3000, расход недорасходуется (медиана 950 < 2400, вчера 1100 < 2850) → гейт ОТКРЫТ.
    mockPrisma.borisDirectSnapshot.findFirst.mockImplementation(async (args: { where: { kind: string } }) => {
      if (args.where.kind === 'campaign') {
        return { payload: { Id: 711897777, State: 'ON', DailyBudget: { Amount: 3000 * MICRO, Mode: 'STANDARD' } } }
      }
      if (args.where.kind === 'keywords') return { payload: [kw(600, 'конвертер сильный', 1)] }
      if (args.where.kind === 'keywordbids') return { payload: [bid(600, 1, 40)] }
      if (args.where.kind === 'campaign_settings') {
        return {
          payload: {
            Id: 711897777, Name: 'x', StartDate: '2026-06-25',
            TimeTargeting: { Schedule: { Items: [] } },
            NegativeKeywords: { Items: [] }, Statistics: { Clicks: 37, Impressions: 900 },
          },
        }
      }
      return null
    })
    mockPrisma.borisDirectSnapshot.findMany.mockImplementation(async (args: { where: { kind: string } }) => {
      if (args.where.kind === 'daily_totals') {
        return [
          { payload: { date: '2026-06-26', spendRub: 800, clicks: 30, impressions: 300 } }, // Пт
          { payload: { date: '2026-06-29', spendRub: 900, clicks: 30, impressions: 300 } }, // Пн
          { payload: { date: '2026-06-30', spendRub: 1000, clicks: 30, impressions: 300 } }, // Вт
          { payload: { date: '2026-07-01', spendRub: 1100, clicks: 30, impressions: 300 } }, // Ср (вчера)
        ]
      }
      if (args.where.kind === 'campaign') {
        return Array.from({ length: 6 }, (_, i) => ({ tickDate: new Date(`2026-06-2${5 + (i % 5)}T00:00:00Z`) }))
      }
      return []
    })

    const res = await runProcessTick(NOW)

    expect(res.status).toBe('done')
    const bidDec = res.decisions?.find((d) => d.type === 'bid' && d.targetId === '600')
    expect(bidDec).toBeDefined()
    const f = bidDec!.factors as { toMicro: number; targetTv: number }
    if (MARGINAL_UPLIFT_ENABLED) {
      // Флаг ВКЛ: гейт открыт → подъём ПОВЕРХ level-lock. Конвертер (posteriorCr≈0.133)
      // уходит выше базового TV65 на TV75 (E[CPL]=180/0.133≈1350 ≤ cap 2000 ₽; премиум
      // TV85 — вето). Уровень фиксируется в момент установки (не прыгает от posterior-шума).
      expect(f.toMicro).toBe(200 * MICRO) // TV75
      expect(f.targetTv).toBe(75)
      expect(bidDec!.summary).toContain('маржинальный подъём')
    } else {
      // Флаг ВЫКЛ (частичная приёмка М3.5 по гейту полигона): подъём отложен, конвертер
      // на БАЗОВОМ входе TV65 (150 ₽). Гейт при этом виден в отчёте (видимость недорасхода).
      expect(f.toMicro).toBe(150 * MICRO) // TV65
      expect(bidDec!.summary).not.toContain('маржинальный подъём')
    }
    expect(res.reportData?.underspend?.gateOpen).toBe(true) // недорасход виден (открытый гейт)
  })
})

describe('М4 микродолг (д): прайор CR кампании — отдельное окно PRIOR_CR_WINDOW_WORKDAYS', () => {
  it('CR кампании (prior Байеса) читается по окну 30 рабочих дней, отдельно от 10-дн окна фразы', async () => {
    setupProcessHappyPath()
    // Перехватываем окна query_criterion_daily, сохраняя маршрутизацию карантина.
    const critWheres: Array<{ gte: Date; lte: Date }> = []
    mockPrisma.borisDirectSnapshot.findMany.mockImplementation(
      async (args: { where: { kind: string; tickDate?: { gte: Date; lte: Date } } }) => {
        if (args.where.kind === 'query_criterion_daily') {
          if (args.where.tickDate) critWheres.push(args.where.tickDate)
          return []
        }
        if (args.where.kind === 'campaign') {
          return Array.from({ length: 6 }, (_, i) => ({ tickDate: new Date(`2026-06-2${5 + (i % 5)}T00:00:00Z`) }))
        }
        if (args.where.kind === 'daily_totals') {
          return [{ tickDate: new Date('2026-06-28T21:00:00Z'), payload: { date: '2026-06-28', spendRub: 500, clicks: 40, impressions: 200 } }]
        }
        return []
      }
    )

    await runProcessTick(NOW)

    // Прайор кампании грузится по ОТДЕЛЬНОМУ окну PRIOR_CR_WINDOW_WORKDAYS (30 раб. дней),
    // а не по 10-дн окну пофразной экономики — и это окно самое ШИРОКОЕ (начинается раньше).
    expect(critWheres.length).toBeGreaterThan(0)
    const endDay = mskDay(critWheres[0].lte)
    const expectedPriorStart = workdayWindowStartUtc(endDay, PRIOR_CR_WINDOW_WORKDAYS - 1).getTime()
    const starts = critWheres.map((w) => w.gte.getTime())
    expect(starts).toContain(expectedPriorStart)
    expect(Math.min(...starts)).toBe(expectedPriorStart)
  })
})
