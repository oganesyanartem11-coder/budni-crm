import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Интеграция контура №0: runDetectorCycle читает снапшоты + один criterion-history
 * отчёт, гоняет чистые детекторы и шлёт алерты. Мокаем транспорт (prisma/отчёт/
 * telegram); детекторы и даты — реальные. Проверяем РЕПЛЕЙ окна 09–13.07.
 */

const { mockPrisma, mockPoll, mockSend } = vi.hoisted(() => ({
  mockPrisma: {
    borisDirectSnapshot: { findFirst: vi.fn(), findMany: vi.fn() },
  },
  mockPoll: vi.fn(),
  mockSend: vi.fn(),
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('./telegram', () => ({ sendToDirectChat: mockSend }))
vi.mock('./reports', async (importActual) => {
  const actual = await importActual<typeof import('./reports')>()
  return { ...actual, pollReport: mockPoll }
})

import { runDetectorCycle } from './detector-cycle'
import { METRIKA_GOAL_ID, MICRO } from './config'

const GOAL_COL = `Conversions_${METRIKA_GOAL_ID}_LSCCD`

/** TSV criterion-history: окно с нулём конверсий + вчера дорогой клик 831 ₽. */
function outageTsv(): string {
  const header = ['Date', 'CriterionId', 'Impressions', 'Clicks', 'Cost', GOAL_COL, 'AvgTrafficVolume', 'AvgClickPosition']
  const rows: string[][] = [
    // Здоровый префикс (Директ конвертил) — база CR засухи.
    ['2026-07-07', '111', '90', '11', '1625', '2', '67.5', '2.55'],
    ['2026-07-08', '111', '70', '9', '278', '1', '47.8', '3.89'],
    // Обрыв: клики есть, конверсий 0.
    ['2026-07-09', '111', '100', '14', '1148', '0', '65.7', '2.64'],
    ['2026-07-10', '111', '80', '7', '842', '0', '62.5', '4.17'],
    ['2026-07-11', '111', '60', '5', '813', '0', '80.6', '3.8'],
    ['2026-07-12', '111', '70', '8', '2067', '0', '64.9', '2.71'],
    // вчера (13.07): дорогой клик 831 ₽ у ключа 222 (1 клик) + обычные
    ['2026-07-13', '111', '50', '8', '740', '0', '73.7', '3.63'],
    ['2026-07-13', '222', '5', '1', '831', '0', '77', '3'],
  ]
  return [header.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n')
}

/** Лесенка со сдвигом медианы входа today vs past. */
function bidRec(keywordId: number, bidRub: number, entryRub: number) {
  return {
    KeywordId: keywordId,
    AdGroupId: 1,
    CampaignId: 1,
    Search: {
      Bid: bidRub * MICRO,
      AuctionBids: [
        { TrafficVolume: 15, Bid: 40 * MICRO, Price: 40 * MICRO },
        { TrafficVolume: 55, Bid: entryRub * MICRO, Price: entryRub * MICRO },
      ],
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Окно metrika_goal: визиты живые, цель 0 (форензика 09–13.07).
  mockPrisma.borisDirectSnapshot.findMany.mockResolvedValue([
    { payload: [{ date: '2026-07-05', visits: 12, goalReaches: 1 }], createdAt: new Date() },
    { payload: [{ date: '2026-07-06', visits: 18, goalReaches: 1 }], createdAt: new Date() },
    { payload: [{ date: '2026-07-07', visits: 16, goalReaches: 1 }], createdAt: new Date() },
    { payload: [{ date: '2026-07-08', visits: 16, goalReaches: 1 }], createdAt: new Date() },
    { payload: [{ date: '2026-07-09', visits: 25, goalReaches: 0 }], createdAt: new Date() },
    { payload: [{ date: '2026-07-10', visits: 11, goalReaches: 0 }], createdAt: new Date() },
    { payload: [{ date: '2026-07-11', visits: 7, goalReaches: 0 }], createdAt: new Date() },
    { payload: [{ date: '2026-07-12', visits: 10, goalReaches: 0 }], createdAt: new Date() },
    { payload: [{ date: '2026-07-13', visits: 19, goalReaches: 0 }], createdAt: new Date() },
  ])
  // findFirst: keywords + keywordbids today/past.
  mockPrisma.borisDirectSnapshot.findFirst.mockImplementation(async (args: { where: { kind: string; tickDate?: unknown } }) => {
    if (args.where.kind === 'keywords') {
      return { payload: [{ Id: 111, Keyword: 'доставка обедов' }, { Id: 222, Keyword: 'питание в офисы' }] }
    }
    if (args.where.kind === 'keywordbids') {
      const isPast = args.where.tickDate != null // past-запрос идёт с tickDate.lte
      return { payload: isPast ? [bidRec(1, 100, 95)] : [bidRec(1, 100, 140)] } // вход 95→140 (+47%)
    }
    return null
  })
  mockPoll.mockResolvedValue({ status: 'ready', tsv: outageTsv() })
  mockSend.mockResolvedValue(undefined)
})

describe('runDetectorCycle — РЕПЛЕЙ окна 09–13.07', () => {
  it('поднимает воронку, засуху, CPC-пробой и дрейф лесенки', async () => {
    const res = await runDetectorCycle(new Date('2026-07-14T07:30:00Z'))
    const texts = mockSend.mock.calls.map((c) => String(c[0]))
    const joined = texts.join('\n---\n')

    // Воронка мертва (визиты живые, цель 0)
    expect(joined).toMatch(/ВОРОНКА/)
    // Засуха Директа
    expect(joined).toMatch(/ДИРЕКТ/)
    // CPC выше потолка — клик 831 ₽
    expect(joined).toMatch(/ПОТОЛОК/)
    expect(joined).toMatch(/831/)
    // Дрейф лесенки (вход 95→140)
    expect(joined).toMatch(/АУКЦИОН/)

    expect(res.alertsSent).toBeGreaterThanOrEqual(4)
    expect(res.ran).toEqual(expect.arrayContaining(['funnel', 'drought', 'cpc', 'ladder']))
  })

  it('здоровое окно (визиты + цели, дешёвые клики, стабильная лесенка) — тишина', async () => {
    mockPrisma.borisDirectSnapshot.findMany.mockResolvedValue([
      { payload: [{ date: '2026-07-09', visits: 20, goalReaches: 2 }], createdAt: new Date() },
      { payload: [{ date: '2026-07-10', visits: 18, goalReaches: 1 }], createdAt: new Date() },
      { payload: [{ date: '2026-07-11', visits: 16, goalReaches: 2 }], createdAt: new Date() },
      { payload: [{ date: '2026-07-12', visits: 15, goalReaches: 1 }], createdAt: new Date() },
      { payload: [{ date: '2026-07-13', visits: 17, goalReaches: 2 }], createdAt: new Date() },
    ])
    const header = ['Date', 'CriterionId', 'Impressions', 'Clicks', 'Cost', GOAL_COL, 'AvgTrafficVolume', 'AvgClickPosition']
    const healthy = [
      ['2026-07-13', '111', '50', '10', '1000', '2', '70', '3'], // cpc 100, 2 конв
    ]
    mockPoll.mockResolvedValue({ status: 'ready', tsv: [header.join('\t'), ...healthy.map((r) => r.join('\t'))].join('\n') })
    mockPrisma.borisDirectSnapshot.findFirst.mockImplementation(async (args: { where: { kind: string; tickDate?: unknown } }) => {
      if (args.where.kind === 'keywords') return { payload: [{ Id: 111, Keyword: 'доставка обедов' }] }
      if (args.where.kind === 'keywordbids') return { payload: [bidRec(1, 100, 95)] } // стабильно 95
      return null
    })

    const res = await runDetectorCycle(new Date('2026-07-14T07:30:00Z'))
    expect(res.alertsSent).toBe(0)
  })
})
