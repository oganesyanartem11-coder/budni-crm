import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  LESSON_BLOCK_MAX_CHARS,
  LESSON_CONFIRM_WEEKS,
  LESSON_MIN_CLICKS,
  LESSON_STALE_WEEKS,
  LESSON_TOP_K,
} from './config'

/**
 * Уроки (lessons.ts). Prisma замокана — без БД. Данные строятся от порогов
 * config; недели — полные МСК-недели (пн-вс) относительно фиксированного «сейчас».
 */

const { mockLesson, mockStat, mockAction } = vi.hoisted(() => ({
  mockLesson: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  mockStat: { findMany: vi.fn() },
  mockAction: { findMany: vi.fn() },
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    borisDirectLesson: mockLesson,
    borisDirectQueryDailyStat: mockStat,
    borisDirectActionLog: mockAction,
  },
}))

import {
  deriveAndRefreshLessons,
  getActiveLessonsForContext,
  formatLessonsBlock,
  getActiveLessonsReport,
} from './lessons'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

// Пятница 3 июля 2026, полдень МСК. Понедельник ТЕКУЩЕЙ недели — 29 июня.
const now = new Date('2026-07-03T12:00:00+03:00')
const MONDAY_CURRENT = new Date('2026-06-29T00:00:00+03:00')

/** Среда полной недели index (0 = последняя полная, 1 = предыдущая, …). */
function weekDate(index: number): Date {
  return new Date(MONDAY_CURRENT.getTime() - (index + 1) * WEEK_MS + 2 * DAY_MS)
}

interface StatOverrides {
  clicks?: number
  costRub?: number
  conversions?: number
}

function stat(date: Date, adGroupId: string, over: StatOverrides = {}) {
  return {
    date,
    adGroupId,
    adGroupName: `${adGroupId}-name`,
    clicks: over.clicks ?? 0,
    costRub: over.costRub ?? 0,
    conversions: over.conversions ?? 0,
  }
}

/**
 * Неделя с «дешёвой» G1 и «средней» G2: G1 cpl 100, G2 cpl 240,
 * средний по кампании 170 → G1 ≤ 0.7×170, G2 между порогами.
 */
function weekRows(index: number, g1Over: StatOverrides = {}) {
  return [
    stat(weekDate(index), 'G1', { clicks: 25, costRub: 1000, conversions: 10, ...g1Over }),
    stat(weekDate(index), 'G2', { clicks: 25, costRub: 2400, conversions: 10 }),
  ]
}

/** Те же данные во всех LESSON_CONFIRM_WEEKS неделях подряд. */
function allWeeksRows(g1Over: StatOverrides = {}) {
  return Array.from({ length: LESSON_CONFIRM_WEEKS }, (_, i) => weekRows(i, g1Over)).flat()
}

function lessonRow(over: Record<string, unknown> = {}) {
  return {
    id: 'les1',
    kind: 'group_economics',
    subjectType: 'adgroup',
    subjectId: 'G1',
    text: 'Группа G1-name: заявки дешевле среднего — 100 ₽ против 170 ₽ по кампании (2 нед. подряд)',
    evidence: { signal: 'cheap' },
    confidence: 0.8,
    status: 'ACTIVE',
    weeksConfirmed: 2,
    lastConfirmedAt: null,
    refutedAt: null,
    createdAt: new Date(now.getTime() - DAY_MS),
    updatedAt: new Date(now.getTime() - DAY_MS),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLesson.findMany.mockResolvedValue([])
  mockLesson.create.mockResolvedValue({})
  mockLesson.update.mockResolvedValue({})
  mockStat.findMany.mockResolvedValue([])
  mockAction.findMany.mockResolvedValue([])
})

describe('deriveAndRefreshLessons — вывод новых уроков (фаза 2)', () => {
  it('сигнал во всех N полных неделях + мин-клики → урок group_economics', async () => {
    mockStat.findMany.mockResolvedValue(allWeeksRows())

    const result = await deriveAndRefreshLessons(now)

    expect(result.created).toBe(1)
    expect(mockLesson.create).toHaveBeenCalledTimes(1)
    const { data } = mockLesson.create.mock.calls[0][0]
    expect(data).toMatchObject({
      kind: 'group_economics',
      subjectType: 'adgroup',
      subjectId: 'G1',
      weeksConfirmed: LESSON_CONFIRM_WEEKS,
    })
    expect(data.confidence).toBeCloseTo(Math.min(0.9, 0.6 + 0.1 * LESSON_CONFIRM_WEEKS))
    // Детерминированный шаблон с цифрами: cpl группы, средний, число недель.
    expect(data.text).toContain('G1-name')
    expect(data.text).toContain('дешевле среднего')
    expect(data.text).toContain('100 ₽ против 170 ₽')
    expect(data.text).toContain(`${LESSON_CONFIRM_WEEKS} нед. подряд`)
    expect(data.evidence.signal).toBe('cheap')

    // Выборка статистики — ровно N полных недель до текущего понедельника.
    expect(mockStat.findMany.mock.calls[0][0].where).toEqual({
      date: {
        gte: new Date(MONDAY_CURRENT.getTime() - LESSON_CONFIRM_WEEKS * WEEK_MS),
        lt: MONDAY_CURRENT,
      },
    })
  })

  it('сигнал только в одной неделе → урок НЕ создаётся', async () => {
    mockStat.findMany.mockResolvedValue(weekRows(0))

    const result = await deriveAndRefreshLessons(now)

    expect(result.created).toBe(0)
    expect(mockLesson.create).not.toHaveBeenCalled()
  })

  it('клики ниже LESSON_MIN_CLICKS → урок НЕ создаётся', async () => {
    mockStat.findMany.mockResolvedValue(allWeeksRows({ clicks: LESSON_MIN_CLICKS - 1 }))

    const result = await deriveAndRefreshLessons(now)

    expect(result.created).toBe(0)
    expect(mockLesson.create).not.toHaveBeenCalled()
  })

  it('«тратит без заявок»: 0 конверсий при расходе выше среднего групп N недель', async () => {
    // G1: клики есть, конверсий 0, расход 3000 ≥ среднего (3000+2400)/2=2700.
    // G2 ниже мин-кликов — конверсии дают средний cpl кампании, но урока по ней нет.
    mockStat.findMany.mockResolvedValue(
      Array.from({ length: LESSON_CONFIRM_WEEKS }, (_, i) => [
        stat(weekDate(i), 'G1', { clicks: 25, costRub: 3000, conversions: 0 }),
        stat(weekDate(i), 'G2', { clicks: LESSON_MIN_CLICKS - 1, costRub: 2400, conversions: 10 }),
      ]).flat()
    )

    const result = await deriveAndRefreshLessons(now)

    expect(result.created).toBe(1)
    const { data } = mockLesson.create.mock.calls[0][0]
    expect(data.evidence.signal).toBe('waste')
    expect(data.text).toContain('тратит без заявок')
    expect(data.text).toContain(String(3000 * LESSON_CONFIRM_WEEKS))
  })

  it('дедуп: не-REFUTED урок по subjectId блокирует создание, но подтверждается (фаза 1)', async () => {
    mockStat.findMany.mockResolvedValue(allWeeksRows())
    mockLesson.findMany.mockResolvedValue([lessonRow()])

    const result = await deriveAndRefreshLessons(now)

    expect(mockLesson.create).not.toHaveBeenCalled()
    expect(result).toMatchObject({ created: 0, confirmed: 1, refuted: 0 })
    expect(mockLesson.update).toHaveBeenCalledWith({
      where: { id: 'les1' },
      data: expect.objectContaining({
        status: 'ACTIVE',
        weeksConfirmed: 3,
        lastConfirmedAt: now,
      }),
    })
  })

  it('уроки action_outcome создаются по исходам improved/worse с цифрами и датой', async () => {
    mockAction.findMany.mockResolvedValue([
      {
        id: 'log1',
        action: 'keywordbids.set',
        createdAt: new Date('2026-06-20T10:00:00+03:00'),
        outcomeVerdict: 'worse',
        outcomeData: {
          before: { clicks: 30, costRub: 2000, conversions: 10, cpl: 200 },
          after: { clicks: 30, costRub: 3500, conversions: 10, cpl: 350 },
          ratio: 1.75,
        },
      },
      {
        id: 'log2',
        action: 'campaigns.update.negatives',
        createdAt: new Date('2026-06-21T10:00:00+03:00'),
        outcomeVerdict: 'improved',
        outcomeData: {
          before: { clicks: 30, costRub: 2000, conversions: 10, cpl: 200 },
          after: { clicks: 30, costRub: 1500, conversions: 10, cpl: 150 },
          ratio: 0.75,
        },
      },
    ])

    const result = await deriveAndRefreshLessons(now)

    expect(result.created).toBe(2)
    const worse = mockLesson.create.mock.calls[0][0].data
    expect(worse).toMatchObject({
      kind: 'action_outcome',
      subjectType: 'action',
      subjectId: 'log1',
      confidence: 0.7,
    })
    expect(worse.text).toContain('keywordbids.set от 20.06')
    expect(worse.text).toContain('не окупилось')
    expect(worse.text).toContain('200')
    expect(worse.text).toContain('350')

    const improved = mockLesson.create.mock.calls[1][0].data
    expect(improved.confidence).toBe(0.6)
    expect(improved.text).toContain('от 21.06')
    expect(improved.text).toContain('окупилось')
    expect(improved.text).not.toContain('не окупилось')
    expect(improved.text).toContain('150')
  })

  it('дедуп action_outcome: урок по этому логу уже есть → не создаётся', async () => {
    mockLesson.findMany.mockResolvedValue([
      lessonRow({ id: 'lesA', kind: 'action_outcome', subjectType: 'action', subjectId: 'log1' }),
    ])
    mockAction.findMany.mockResolvedValue([
      {
        id: 'log1',
        action: 'keywordbids.set',
        createdAt: new Date('2026-06-20T10:00:00+03:00'),
        outcomeVerdict: 'worse',
        outcomeData: null,
      },
    ])

    const result = await deriveAndRefreshLessons(now)

    expect(result.created).toBe(0)
    expect(mockLesson.create).not.toHaveBeenCalled()
  })
})

describe('deriveAndRefreshLessons — перепроверка (фаза 1)', () => {
  it('сигнал развернулся при достаточных данных → REFUTED', async () => {
    // Последняя неделя: G1 стала дорогой (300 против среднего 200 → ≥1.5×).
    mockStat.findMany.mockResolvedValue([
      stat(weekDate(0), 'G1', { clicks: 25, costRub: 3000, conversions: 10 }),
      stat(weekDate(0), 'G2', { clicks: 25, costRub: 1000, conversions: 10 }),
    ])
    mockLesson.findMany.mockResolvedValue([lessonRow()]) // урок «G1 дешёвая»

    const result = await deriveAndRefreshLessons(now)

    expect(result.refuted).toBe(1)
    expect(mockLesson.update).toHaveBeenCalledWith({
      where: { id: 'les1' },
      data: { status: 'REFUTED', refutedAt: now },
    })
    // Разворот не рождает встречный урок в тот же прогон (дедуп по не-REFUTED).
    expect(mockLesson.create).not.toHaveBeenCalled()
  })

  it('нет данных дольше LESSON_STALE_WEEKS → STALE (и для action_outcome от createdAt)', async () => {
    const oldDate = new Date(now.getTime() - (LESSON_STALE_WEEKS * 7 + 1) * DAY_MS)
    mockLesson.findMany.mockResolvedValue([
      lessonRow({ id: 'старый-групповой', lastConfirmedAt: oldDate }),
      lessonRow({
        id: 'старый-исход',
        kind: 'action_outcome',
        subjectType: 'action',
        subjectId: 'logX',
        createdAt: oldDate,
      }),
      lessonRow({ id: 'свежий-исход', kind: 'action_outcome', subjectType: 'action', subjectId: 'logY' }),
    ])

    const result = await deriveAndRefreshLessons(now)

    expect(result.staled).toBe(2)
    expect(mockLesson.update).toHaveBeenCalledTimes(2)
    for (const call of mockLesson.update.mock.calls) {
      expect(call[0].data).toEqual({ status: 'STALE' })
    }
    const staledIds = mockLesson.update.mock.calls.map((c) => c[0].where.id)
    expect(staledIds).toEqual(expect.arrayContaining(['старый-групповой', 'старый-исход']))
  })

  it('данных мало, но срок не вышел → урок не трогаем', async () => {
    mockLesson.findMany.mockResolvedValue([lessonRow()]) // createdAt вчера, статистики нет

    const result = await deriveAndRefreshLessons(now)

    expect(result).toEqual({ created: 0, confirmed: 0, refuted: 0, staled: 0 })
    expect(mockLesson.update).not.toHaveBeenCalled()
  })
})

describe('getActiveLessonsForContext', () => {
  function activeLesson(id: string, over: Record<string, unknown> = {}) {
    return lessonRow({ id, subjectId: null, text: `урок ${id}`, weeksConfirmed: 0, ...over })
  }

  it('берёт только ACTIVE, сортирует: релевантные группы → confidence', async () => {
    mockLesson.findMany.mockResolvedValue([
      activeLesson('a', { confidence: 0.9 }),
      activeLesson('b', { confidence: 0.7, subjectId: 'G7' }),
      activeLesson('c', { confidence: 0.8 }),
    ])

    const picked = await getActiveLessonsForContext({ topK: 2, relevantAdGroupIds: ['G7'] })

    expect(mockLesson.findMany).toHaveBeenCalledWith({ where: { status: 'ACTIVE' } })
    expect(picked.map((l) => l.id)).toEqual(['b', 'a'])
    expect(picked[0]).toEqual({ id: 'b', kind: 'group_economics', text: 'урок b' })
  })

  it('дефолтный topK = LESSON_TOP_K', async () => {
    mockLesson.findMany.mockResolvedValue(
      Array.from({ length: LESSON_TOP_K + 3 }, (_, i) => activeLesson(`l${i}`))
    )

    const picked = await getActiveLessonsForContext()

    expect(picked).toHaveLength(LESSON_TOP_K)
  })

  it('накопительный лимит символов: не влезший целиком отбрасывается', async () => {
    const lenA = Math.floor(LESSON_BLOCK_MAX_CHARS * 0.6)
    const lenB = Math.floor(LESSON_BLOCK_MAX_CHARS * 0.5) // A+B > лимита → B мимо
    const lenC = Math.floor(LESSON_BLOCK_MAX_CHARS * 0.3) // A+C ≤ лимита → C входит
    mockLesson.findMany.mockResolvedValue([
      activeLesson('a', { confidence: 0.9, text: 'а'.repeat(lenA) }),
      activeLesson('b', { confidence: 0.8, text: 'б'.repeat(lenB) }),
      activeLesson('c', { confidence: 0.7, text: 'в'.repeat(lenC) }),
    ])

    const picked = await getActiveLessonsForContext({ topK: 10 })

    expect(picked.map((l) => l.id)).toEqual(['a', 'c'])
  })

  it('при равной confidence свежее (lastConfirmedAt ?? createdAt) — первым', async () => {
    mockLesson.findMany.mockResolvedValue([
      activeLesson('старый', { createdAt: new Date(now.getTime() - 10 * DAY_MS) }),
      activeLesson('свежий', {
        createdAt: new Date(now.getTime() - 10 * DAY_MS),
        lastConfirmedAt: new Date(now.getTime() - DAY_MS),
      }),
    ])

    const picked = await getActiveLessonsForContext()

    expect(picked.map((l) => l.id)).toEqual(['свежий', 'старый'])
  })
})

describe('formatLessonsBlock', () => {
  it('пустой список → пустая строка', () => {
    expect(formatLessonsBlock([])).toBe('')
  })

  it('заголовок «ОПЫТ» и строки с дефисами', () => {
    const block = formatLessonsBlock([
      { id: '1', kind: 'group_economics', text: 'урок один' },
      { id: '2', kind: 'action_outcome', text: 'урок два' },
    ])
    expect(block).toBe('ОПЫТ (мои проверенные уроки):\n- урок один\n- урок два')
  })
})

describe('getActiveLessonsReport', () => {
  it('нет ACTIVE-уроков → дословный текст-заглушка', async () => {
    mockLesson.findMany.mockResolvedValue([lessonRow({ status: 'STALE' })])

    const report = await getActiveLessonsReport()

    expect(report).toBe(
      'Пока уроков нет — мало данных. Коплю историю по фразам и исходам действий, первые выводы появятся через пару недель работы кампании.'
    )
  })

  it('нумерованный список с видом по-русски, недели подтверждения и хвост про устаревшие', async () => {
    mockLesson.findMany.mockResolvedValue([
      lessonRow({ id: 'l1', text: 'Группа G1-name: дешёвые заявки', weeksConfirmed: 3, confidence: 0.9 }),
      lessonRow({
        id: 'l2',
        kind: 'action_outcome',
        subjectType: 'action',
        subjectId: 'log1',
        text: 'keywordbids.set от 20.06: не окупилось — цена заявки 200 → 350 ₽',
        weeksConfirmed: 0,
        confidence: 0.7,
      }),
      lessonRow({ id: 'l3', status: 'STALE' }),
      lessonRow({ id: 'l4', status: 'REFUTED' }),
    ])

    const report = await getActiveLessonsReport()

    expect(report).toContain('1. Группа G1-name: дешёвые заявки (экономика группы, подтверждён 3 нед.)')
    expect(report).toContain('2. keywordbids.set от 20.06: не окупилось — цена заявки 200 → 350 ₽ (исход действия)')
    expect(report).toContain('Устарело: 1, опровергнуто: 1')
    // Без markdown-символов.
    expect(report).not.toMatch(/[*_#|]/)
  })
})
