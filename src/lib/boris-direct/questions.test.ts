import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Память вопросов (спринт 14.07, фундамент спринта 2): гипотезы консилиума и
 * вопросы-аналитика персистятся в BorisDirectSnapshot (kind='consilium' /
 * 'analyst_questions'). БЕЗ LLM-потребителей (это спринт 2) — только хранение+API.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    borisDirectSnapshot: { findFirst: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

import {
  persistConsilium,
  createQuestion,
  updateQuestion,
  getActiveQuestions,
  getLatestQuestions,
  isTopicOnCooldown,
  type AnalystQuestion,
} from './questions'
import { ANALYST_QUESTIONS_KEEP } from './config'

/** Перехватываем последний созданный снапшот вида kind. */
function lastCreatedPayload(kind: string): unknown {
  const calls = mockPrisma.borisDirectSnapshot.create.mock.calls as Array<[{ data: { kind: string; payload: unknown } }]>
  const match = [...calls].reverse().find((c) => c[0].data.kind === kind)
  return match ? match[0].data.payload : undefined
}

/** Мокаем «последний снапшот analyst_questions» = payload. */
function setLatestQuestions(payload: unknown) {
  mockPrisma.borisDirectSnapshot.findFirst.mockImplementation(
    async (args: { where: { kind: string } }) => (args.where.kind === 'analyst_questions' ? { payload } : null)
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.borisDirectSnapshot.findFirst.mockResolvedValue(null)
  mockPrisma.borisDirectSnapshot.create.mockResolvedValue({})
})

describe('persistConsilium', () => {
  it('пишет снапшот kind=consilium со статусом open и периодом', async () => {
    await persistConsilium({
      text: 'Консилиум недели\n1. Гипотеза...',
      from: '2026-07-06',
      to: '2026-07-12',
      now: new Date('2026-07-13T06:20:00Z'),
    })
    const p = lastCreatedPayload('consilium') as Record<string, unknown>
    expect(p).toBeTruthy()
    expect(p.status).toBe('open')
    expect(p.from).toBe('2026-07-06')
    expect(p.to).toBe('2026-07-12')
    expect(String(p.text)).toMatch(/Гипотеза/)
  })

  it('пустой текст не персистится (нечего хранить)', async () => {
    await persistConsilium({ text: '   ', from: 'a', to: 'b', now: new Date('2026-07-13T06:00:00Z') })
    expect(lastCreatedPayload('consilium')).toBeUndefined()
  })
})

describe('createQuestion', () => {
  it('добавляет вопрос со статусом open в свежий снапшот', async () => {
    await createQuestion({
      question: 'Почему клик 831 ₽ при потолке 400?',
      check: 'сверить бид-модификаторы (bidmodifiers.get)',
      now: new Date('2026-07-14T07:30:00Z'),
    })
    const arr = lastCreatedPayload('analyst_questions') as Array<Record<string, unknown>>
    expect(arr).toHaveLength(1)
    expect(arr[0].status).toBe('open')
    expect(arr[0].question).toMatch(/831/)
    expect(arr[0].check).toMatch(/модификатор/)
    expect(arr[0].result).toBeNull()
    expect(typeof arr[0].id).toBe('string')
  })

  it('дописывает к существующим вопросам, не теряя их', async () => {
    setLatestQuestions([
      { id: 'q1', question: 'старый', status: 'open', check: 'c', result: null, createdMsk: '2026-07-13', updatedMsk: '2026-07-13' },
    ])
    await createQuestion({ question: 'новый', check: 'c2', now: new Date('2026-07-14T07:30:00Z') })
    const arr = lastCreatedPayload('analyst_questions') as Array<Record<string, unknown>>
    expect(arr).toHaveLength(2)
    expect(arr.map((q) => q.question)).toContain('старый')
    expect(arr.map((q) => q.question)).toContain('новый')
  })
})

describe('updateQuestion', () => {
  it('меняет статус и результат по id', async () => {
    setLatestQuestions([
      { id: 'q1', question: 'q', status: 'open', check: 'c', result: null, createdMsk: '2026-07-13', updatedMsk: '2026-07-13' },
    ])
    await updateQuestion('q1', { status: 'confirmed', result: 'модификатор моб +150%' }, new Date('2026-07-15T07:00:00Z'))
    const arr = lastCreatedPayload('analyst_questions') as Array<Record<string, unknown>>
    expect(arr[0].status).toBe('confirmed')
    expect(arr[0].result).toMatch(/модификатор/)
    expect(arr[0].updatedMsk).toBe('2026-07-15')
  })

  it('неизвестный id не создаёт снапшот (нечего менять)', async () => {
    setLatestQuestions([{ id: 'q1', question: 'q', status: 'open', check: 'c', result: null, createdMsk: 'x', updatedMsk: 'x' }])
    await updateQuestion('nope', { status: 'refuted' }, new Date('2026-07-15T07:00:00Z'))
    expect(lastCreatedPayload('analyst_questions')).toBeUndefined()
  })
})

describe('getActiveQuestions', () => {
  it('возвращает только open/checking (закрытые отфильтрованы)', async () => {
    setLatestQuestions([
      { id: 'q1', question: 'a', status: 'open', check: 'c', result: null, createdMsk: 'x', updatedMsk: 'x' },
      { id: 'q2', question: 'b', status: 'checking', check: 'c', result: null, createdMsk: 'x', updatedMsk: 'x' },
      { id: 'q3', question: 'c', status: 'confirmed', check: 'c', result: 'r', createdMsk: 'x', updatedMsk: 'x' },
      { id: 'q4', question: 'd', status: 'refuted', check: 'c', result: 'r', createdMsk: 'x', updatedMsk: 'x' },
    ])
    const active = await getActiveQuestions()
    expect(active.map((q) => q.id)).toEqual(['q1', 'q2'])
  })

  it('нет снапшота → пустой список', async () => {
    expect(await getActiveQuestions()).toEqual([])
  })
})

// ---------- Спринт «Аналитик»: topicKey + checkSpec, полный список, cooldown, прунинг ----------

describe('createQuestion (аналитик): topicKey + checkSpec', () => {
  it('сохраняет topicKey и машинную спецификацию проверки', async () => {
    await createQuestion({
      question: 'Клик→заявка обвалился 09.07: серия нулей при живых визитах?',
      check: 'серия цели Метрики по дням за окно',
      topicKey: 'funnel_zero_series',
      checkSpec: { key: 'metrika_goal_series', params: { windowDays: 14 } },
      now: new Date('2026-07-14T07:30:00Z'),
    })
    const arr = lastCreatedPayload('analyst_questions') as Array<Record<string, unknown>>
    expect(arr[0].topicKey).toBe('funnel_zero_series')
    expect(arr[0].checkSpec).toEqual({ key: 'metrika_goal_series', params: { windowDays: 14 } })
  })
})

describe('getLatestQuestions', () => {
  it('возвращает ВЕСЬ последний список, включая закрытые (для cooldown/скана)', async () => {
    setLatestQuestions([
      { id: 'q1', question: 'a', status: 'open', check: 'c', result: null, createdMsk: 'x', updatedMsk: 'x' },
      { id: 'q3', question: 'c', status: 'confirmed', check: 'c', result: 'r', createdMsk: 'x', updatedMsk: 'x' },
    ])
    const all = await getLatestQuestions()
    expect(all.map((q) => q.id)).toEqual(['q1', 'q3'])
  })

  it('нет снапшота → пустой список', async () => {
    expect(await getLatestQuestions()).toEqual([])
  })
})

describe('createQuestion: прунинг памяти вопросов', () => {
  it(`держит последние ${ANALYST_QUESTIONS_KEEP}, отбрасывая самые старые`, async () => {
    const existing = Array.from({ length: ANALYST_QUESTIONS_KEEP }, (_, i) => ({
      id: `old_${i}`,
      question: `q${i}`,
      status: 'confirmed' as const,
      check: 'c',
      result: 'r',
      createdMsk: '2026-07-01',
      updatedMsk: '2026-07-01',
    }))
    setLatestQuestions(existing)
    await createQuestion({ question: 'новейший', check: 'c', now: new Date('2026-07-14T07:30:00Z') })
    const arr = lastCreatedPayload('analyst_questions') as Array<Record<string, unknown>>
    expect(arr).toHaveLength(ANALYST_QUESTIONS_KEEP)
    // Старейший (old_0) вытеснен, новейший на месте.
    expect(arr.map((q) => q.id)).not.toContain('old_0')
    expect(arr[arr.length - 1].question).toBe('новейший')
  })
})

describe('isTopicOnCooldown', () => {
  const q = (topicKey: string, createdMsk: string): AnalystQuestion => ({
    id: `q_${topicKey}_${createdMsk}`,
    question: 'q',
    status: 'refuted',
    check: 'c',
    result: 'r',
    createdMsk,
    updatedMsk: createdMsk,
    topicKey,
  })

  it('тема поднята < N дней назад → на cooldown', () => {
    const list = [q('funnel_zero_series', '2026-07-12')]
    expect(isTopicOnCooldown(list, 'funnel_zero_series', '2026-07-14', 3)).toBe(true)
  })

  it('тема поднята ровно N дней назад → уже можно (граница исключительна)', () => {
    const list = [q('funnel_zero_series', '2026-07-11')]
    expect(isTopicOnCooldown(list, 'funnel_zero_series', '2026-07-14', 3)).toBe(false)
  })

  it('другая тема на cooldown не влияет', () => {
    const list = [q('cpc_leak', '2026-07-14')]
    expect(isTopicOnCooldown(list, 'funnel_zero_series', '2026-07-14', 3)).toBe(false)
  })

  it('пустой topicKey (без темы) никогда не на cooldown', () => {
    const list = [q('funnel_zero_series', '2026-07-14')]
    expect(isTopicOnCooldown(list, '', '2026-07-14', 3)).toBe(false)
  })
})
