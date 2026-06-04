import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * MEGA-4b (П3): parseChangeIntent.
 *
 * Зовёт Anthropic (tool_use submit_change_intent). Мокаем клиента —
 * проверяем: (1) парсинг tool_use → CHANGE/NONE; (2) все 9 промт-примеров;
 * (3) постпроцессинг-гварды (incomplete, low confidence, past_date,
 * too_far_future, out_of_range, unknown_meal_type); (4) fail-safe → NONE
 * parse_error. Реального LLM не дёргаем. «Сегодня» зафиксировано детерминированно.
 */

const mockCreate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/llm/client', () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}))
vi.mock('@/lib/ai/models', () => ({ getInboxModel: () => 'claude-test' }))

import { parseChangeIntent, type MealType } from './parse-change-intent'

// Детерминированное «сегодня»: 2026-06-04 (среда) 10:00 МСК = 07:00 UTC.
const TODAY = new Date(Date.UTC(2026, 5, 4, 7, 0, 0))

const ALL_MEALS: MealType[] = ['ЗАВТРАК', 'ОБЕД', 'УЖИН']

function toolResponse(input: Record<string, unknown>) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'submit_change_intent', input }],
  }
}

function run(
  text: string,
  opts?: { availableMealTypes?: MealType[]; today?: Date },
) {
  return parseChangeIntent(text, {
    clientName: 'ООО Ромашка',
    today: opts?.today ?? TODAY,
    availableMealTypes: opts?.availableMealTypes ?? ALL_MEALS,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('parseChangeIntent — 9 промт-примеров', () => {
  it('1. «надо 13 обедов на завтра» → CHANGE 13 / 2026-06-05 / ОБЕД', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 13,
        date: '2026-06-05',
        mealType: 'ОБЕД',
        confidence: 0.97,
        reason: 'явно',
      }),
    )
    const r = await run('надо 13 обедов на завтра')
    expect(r.action).toBe('CHANGE')
    if (r.action === 'CHANGE') {
      expect(r.portions).toBe(13)
      expect(r.date).toBe('2026-06-05')
      expect(r.mealType).toBe('ОБЕД')
      expect(r.confidence).toBe(0.97)
    }
  })

  it('2. «давайте 7 на пятницу» → CHANGE 7 / 2026-06-06 / null', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 7,
        date: '2026-06-06',
        mealType: null,
        confidence: 0.93,
        reason: 'явно',
      }),
    )
    const r = await run('давайте 7 на пятницу')
    expect(r.action).toBe('CHANGE')
    if (r.action === 'CHANGE') {
      expect(r.portions).toBe(7)
      expect(r.date).toBe('2026-06-06')
      expect(r.mealType).toBeNull()
    }
  })

  it('3. «сделай 15 на 06.06» → CHANGE 15 / 2026-06-06 / null', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 15,
        date: '2026-06-06',
        mealType: null,
        confidence: 0.96,
        reason: 'явно',
      }),
    )
    const r = await run('сделай 15 на 06.06')
    expect(r.action).toBe('CHANGE')
    if (r.action === 'CHANGE') {
      expect(r.portions).toBe(15)
      expect(r.date).toBe('2026-06-06')
      expect(r.mealType).toBeNull()
    }
  })

  it('4. «надо 13» → NONE (нет даты)', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({ action: 'NONE', confidence: 0.9, reason: 'нет даты' }),
    )
    const r = await run('надо 13')
    expect(r.action).toBe('NONE')
  })

  it('5. «отмените завтра» → NONE (отмена)', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({ action: 'NONE', confidence: 0.95, reason: 'отмена' }),
    )
    const r = await run('отмените завтра')
    expect(r.action).toBe('NONE')
  })

  it('6. «12 завтра и 14 в пятницу» → NONE (несколько дат)', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({ action: 'NONE', confidence: 0.92, reason: 'несколько дат' }),
    )
    const r = await run('12 завтра и 14 в пятницу')
    expect(r.action).toBe('NONE')
  })

  it('7. «спасибо!» → NONE (благодарность)', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({ action: 'NONE', confidence: 0.99, reason: 'благодарность' }),
    )
    const r = await run('спасибо!')
    expect(r.action).toBe('NONE')
  })

  it('8. «через пол часа» → NONE', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({ action: 'NONE', confidence: 0.9, reason: 'не изменение' }),
    )
    const r = await run('через пол часа')
    expect(r.action).toBe('NONE')
  })

  it('9. «завтрак 5 на 06.06» → CHANGE 5 / 2026-06-06 / ЗАВТРАК', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 5,
        date: '2026-06-06',
        mealType: 'ЗАВТРАК',
        confidence: 0.96,
        reason: 'явно',
      }),
    )
    const r = await run('завтрак 5 на 06.06')
    expect(r.action).toBe('CHANGE')
    if (r.action === 'CHANGE') {
      expect(r.portions).toBe(5)
      expect(r.date).toBe('2026-06-06')
      expect(r.mealType).toBe('ЗАВТРАК')
    }
  })
})

describe('parseChangeIntent — постпроцессинг-гварды', () => {
  it('CHANGE но portions=null → NONE incomplete', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: null,
        date: '2026-06-06',
        mealType: null,
        confidence: 0.97,
        reason: 'явно',
      }),
    )
    const r = await run('что-то')
    expect(r).toEqual({ action: 'NONE', reason: 'incomplete' })
  })

  it('CHANGE но date=null → NONE incomplete', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 13,
        date: null,
        mealType: null,
        confidence: 0.97,
        reason: 'явно',
      }),
    )
    const r = await run('надо 13')
    expect(r).toEqual({ action: 'NONE', reason: 'incomplete' })
  })

  it('confidence=0.70 → NONE incomplete', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 13,
        date: '2026-06-06',
        mealType: null,
        confidence: 0.7,
        reason: 'сомнения',
      }),
    )
    const r = await run('может 13 на пятницу?')
    expect(r).toEqual({ action: 'NONE', reason: 'incomplete' })
  })

  it('date=2025-01-01 (далёкое прошлое) → NONE past_date', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 13,
        date: '2025-01-01',
        mealType: null,
        confidence: 0.97,
        reason: 'явно',
      }),
    )
    const r = await run('13 на 01.01.2025')
    expect(r).toEqual({ action: 'NONE', reason: 'past_date' })
  })

  it('date=вчера (2026-06-03) → NONE past_date', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 13,
        date: '2026-06-03',
        mealType: null,
        confidence: 0.97,
        reason: 'явно',
      }),
    )
    const r = await run('13 на вчера')
    expect(r).toEqual({ action: 'NONE', reason: 'past_date' })
  })

  it('date=сегодня (2026-06-04) → CHANGE (граница включена)', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 13,
        date: '2026-06-04',
        mealType: null,
        confidence: 0.97,
        reason: 'явно',
      }),
    )
    const r = await run('13 на сегодня')
    expect(r.action).toBe('CHANGE')
  })

  it('date=сегодня+14 (2026-06-18) → CHANGE (граница включена)', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 13,
        date: '2026-06-18',
        mealType: null,
        confidence: 0.97,
        reason: 'явно',
      }),
    )
    const r = await run('13 на 18.06')
    expect(r.action).toBe('CHANGE')
  })

  it('date=сегодня+15 (2026-06-19) → NONE too_far_future', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 13,
        date: '2026-06-19',
        mealType: null,
        confidence: 0.97,
        reason: 'явно',
      }),
    )
    const r = await run('13 на 19.06')
    expect(r).toEqual({ action: 'NONE', reason: 'too_far_future' })
  })

  it('mealType=ЗАВТРАК но availableMealTypes=[ОБЕД] → NONE unknown_meal_type', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 5,
        date: '2026-06-06',
        mealType: 'ЗАВТРАК',
        confidence: 0.96,
        reason: 'явно',
      }),
    )
    const r = await run('завтрак 5 на 06.06', { availableMealTypes: ['ОБЕД'] })
    expect(r).toEqual({ action: 'NONE', reason: 'unknown_meal_type' })
  })

  it('portions=0 → NONE out_of_range', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 0,
        date: '2026-06-06',
        mealType: null,
        confidence: 0.97,
        reason: 'явно',
      }),
    )
    const r = await run('0 на 06.06')
    expect(r).toEqual({ action: 'NONE', reason: 'out_of_range' })
  })

  it('portions=1001 → NONE out_of_range', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        action: 'CHANGE',
        portions: 1001,
        date: '2026-06-06',
        mealType: null,
        confidence: 0.97,
        reason: 'явно',
      }),
    )
    const r = await run('1001 на 06.06')
    expect(r).toEqual({ action: 'NONE', reason: 'out_of_range' })
  })
})

describe('parseChangeIntent — fail-safe', () => {
  it('LLM бросает ошибку → NONE parse_error', async () => {
    mockCreate.mockRejectedValue(new Error('rate limit'))
    const r = await run('надо 13 обедов на завтра')
    expect(r).toEqual({ action: 'NONE', reason: 'parse_error' })
  })

  it('нет tool_use в ответе → NONE parse_error', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hi' }],
    })
    const r = await run('надо 13 обедов на завтра')
    expect(r).toEqual({ action: 'NONE', reason: 'parse_error' })
  })
})

describe('parseChangeIntent — промт', () => {
  it('SYSTEM содержит clientName, today и availableMealTypes', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({ action: 'NONE', confidence: 0.9, reason: 'x' }),
    )
    await run('спасибо', { availableMealTypes: ['ЗАВТРАК', 'ОБЕД'] })
    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toMatch(/ООО Ромашка/)
    expect(call.system).toMatch(/2026-06-04/)
    expect(call.system).toMatch(/ЗАВТРАК, ОБЕД/)
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'submit_change_intent' })
  })
})
