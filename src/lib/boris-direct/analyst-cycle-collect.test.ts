import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ИНТЕГРАЦИОННАЯ приёмка сборщика дашборда (спринт 14.07, ШАГ 2). Живая БД в среде
 * разработки недоступна (Neon compute спит, P1001) — поэтому «единственную непокрытую
 * точку» (сборщик collectAnalystDashboard на РЕАЛЬНЫХ снапшотах) закрываем прогоном
 * НАСТОЯЩЕЙ collectAnalystDashboard через мок prisma с ПРОД-ФОРМНЫМИ payload'ами.
 * Цель — доказать здесь и сейчас: сборщик не падает, все секции печатаются, поля
 * смаплены верно (расход/клики/заявки/CPL, лесенка, прогноз, статусы), токены в
 * бюджете. Это ловит «поля кривые» без живого прогона.
 *
 * НИ ОДНОГО write, НИ ОДНОГО вызова LLM/Директа/Метрики: сборщик читает только БД.
 */

const NOW = new Date('2026-07-14T07:00:00Z') // МСК-день 2026-07-14, вчера 2026-07-13

// Прод-формные снапшоты daily_totals (расход/клики/показы).
const DAILY = [
  { date: '2026-07-11', spendRub: 900, clicks: 12, impressions: 400 },
  { date: '2026-07-12', spendRub: 820, clicks: 10, impressions: 380 },
  { date: '2026-07-13', spendRub: 780, clicks: 10, impressions: 360 },
]
// Лесенка (нормализованная): вход TV55 = 95 ₽.
const KEYWORDBIDS = [
  {
    KeywordId: 1,
    AdGroupId: 5769314414,
    CampaignId: 711897777,
    Search: {
      Bid: 95_000_000,
      AuctionBids: [
        { TrafficVolume: 55, Bid: 95_000_000, Price: 95_000_000 },
        { TrafficVolume: 75, Bid: 130_000_000, Price: 130_000_000 },
      ],
    },
  },
]
const ACTIVE_QUESTIONS = [
  {
    id: 'q_2026-07-13_0',
    question: 'Клик→заявка обвалился — нулевая серия?',
    status: 'checking',
    check: 'серия цели Метрики',
    result: null,
    createdMsk: '2026-07-13',
    updatedMsk: '2026-07-13',
    topicKey: 'funnel_zero_series',
    checkSpec: { key: 'metrika_goal_series', params: { windowDays: 14 } },
  },
]

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    borisDirectSnapshot: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    borisDirectProposal: { count: vi.fn() },
  },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

// Внешние читатели (не БД-снапшоты) — прод-формные заглушки.
vi.mock('./attribution', () => ({
  getLeadsForPeriod: vi.fn(async () => [
    { createdAt: new Date('2026-07-11T09:00:00Z'), phoneDigits: '79001112233', utmTerm: 'обеды в офис' },
    // 12.07 и 13.07 — заявок нет (нулевые дни: CPL «—», расход печатается числом).
  ]),
  splitLeadsByOrigin: (leads: unknown[]) => ({ fromDirect: leads, fromOther: [] }),
  dedupeLeadsByPhone: (leads: unknown[]) => leads,
}))
vi.mock('./test-markers', () => ({ filterOutTestLeads: (leads: unknown[]) => leads }))
vi.mock('./lessons', () => ({ getActiveLessonsReport: vi.fn(async () => 'Урок: мобильные конвертят хуже десктопа.') }))
vi.mock('./deals', () => ({
  getWonDeals: vi.fn(async () => ({ inPeriod: [{ dealAmount: 40000 }], all: [{ dealAmount: 40000 }] })),
  aggregateRevenueByPhrase: vi.fn(() => ({
    byPhrase: [],
    unattributedRevenue: 0,
    unattributedDeals: 0,
    totalRevenue: 40000,
    dealCount: 2,
    avgCheckRub: 20000,
  })),
}))
vi.mock('./state', () => ({
  getDirectRoleState: vi.fn(async () => ({ mode: 'LIVE', frozen: false, autoNegativesEnabled: true })),
}))
// forecast: держим renderForecastLine настоящим, подменяем только loadForecastForDay (иначе БД).
vi.mock('./forecast', async (importActual) => {
  const actual = await importActual<typeof import('./forecast')>()
  return {
    ...actual,
    loadForecastForDay: vi.fn(async () => ({
      maturing: false as const,
      clicks: { mean: 12, std: 3, n: 6 },
      spend: { mean: 800, std: 90, n: 6 },
      targetIsWorkday: true,
    })),
  }
})

import { collectAnalystDashboard } from './analyst-cycle'
import { estimateTokens } from './analyst-dashboard'

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.borisDirectProposal.count.mockResolvedValue(3)
  mockPrisma.borisDirectSnapshot.findMany.mockImplementation(async (args: { where: { kind: string } }) =>
    args.where.kind === 'daily_totals' ? DAILY.map((d) => ({ payload: d, tickDate: new Date(`${d.date}T00:00:00Z`) })) : []
  )
  mockPrisma.borisDirectSnapshot.findFirst.mockImplementation(async (args: { where: { kind: string } }) => {
    switch (args.where.kind) {
      case 'daily_totals':
        return { payload: DAILY[DAILY.length - 1], tickDate: new Date('2026-07-13T00:00:00Z') } // «вчера» для прогноза
      case 'keywordbids':
        return { payload: KEYWORDBIDS, tickDate: new Date('2026-07-14T00:00:00Z') }
      case 'analyst_questions':
        return { payload: ACTIVE_QUESTIONS, tickDate: new Date('2026-07-13T00:00:00Z') }
      case 'consilium':
        return { payload: { text: 'Гипотеза: ставки протухли относительно аукциона', status: 'open' }, tickDate: new Date() }
      default:
        return null
    }
  })
})

describe('collectAnalystDashboard на прод-формных снапшотах', () => {
  it('не падает и печатает все ожидаемые секции', async () => {
    const text = await collectAnalystDashboard(NOW, { detectorAlerts: ['[ВОРОНКА] визиты живые, целей ноль'] })
    expect(text).toMatch(/ДАШБОРД АНАЛИТИКА за 2026-07-14/)
    expect(text).toMatch(/режим LIVE/)
    for (const section of [/\nДНИ /, /ПРОГНОЗ\/факт/, /\nЛЕСЕНКА:/, /\nСТАТУСЫ /, /\nДЕТЕКТОРЫ /, /\nКОНСИЛИУМ /, /\nВОПРОСЫ /, /\nУРОКИ /, /\nДЕНЬГИ /]) {
      expect(text).toMatch(section)
    }
  })

  it('поля смаплены верно: расход числом, заявки/CPL по дням', async () => {
    const text = await collectAnalystDashboard(NOW, {})
    // 11.07: 1 заявка → CPL = 900 ₽ (число, не «—»); расход 900 ₽ (не «?»).
    const l11 = text.split('\n').find((l) => l.includes('2026-07-11'))!
    expect(l11).toMatch(/900 ₽ \/ 12 \/ 1 \/ 900 ₽/)
    // 13.07: 0 заявок → CPL «—», но расход печатается числом (данные есть).
    const l13 = text.split('\n').find((l) => l.includes('2026-07-13'))!
    expect(l13).toMatch(/780 ₽ \/ 10 \/ 0 \/ —/)
    // Нигде в блоке ДНЕЙ нет «?» (расход известен для всех дней).
    const dayLines = text.split('\n').filter((l) => /^\- 2026-07-\d\d:/.test(l))
    expect(dayLines.every((l) => !l.includes('?'))).toBe(true)
  })

  it('прогноз собран настоящим renderForecastLine; лесенка = 95 ₽; статусы LIVE + 3 предложения', async () => {
    const text = await collectAnalystDashboard(NOW, {})
    expect(text).toMatch(/ждал 12±3, факт 10/)
    expect(text).toMatch(/ЛЕСЕНКА:.*95 ₽/)
    expect(text).toMatch(/режим LIVE.*авто-минуса вкл/)
    expect(text).toMatch(/открытых предложений владельцу: 3/)
    expect(text).toMatch(/выручка окна: 40000 ₽ по 2 сделкам/)
  })

  it('токены в бюджете (< 4000; на живом объёме ~2-4k)', async () => {
    const text = await collectAnalystDashboard(NOW, { detectorAlerts: ['[ВОРОНКА] ...'] })
    const tokens = estimateTokens(text)
    expect(tokens).toBeGreaterThan(50)
    expect(tokens).toBeLessThan(4000)
  })

  it('деградация: пустая БД (все снапшоты null) — не падает, печатает шапку+пустое окно', async () => {
    mockPrisma.borisDirectSnapshot.findMany.mockResolvedValue([])
    mockPrisma.borisDirectSnapshot.findFirst.mockResolvedValue(null)
    const text = await collectAnalystDashboard(NOW, {})
    expect(text).toMatch(/ДАШБОРД АНАЛИТИКА/)
    expect(text).toMatch(/ДНИ /) // секция есть даже пустая
  })
})
