import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getVisionModel } from '@/lib/ai/models'

// Мокаем singleton Anthropic-клиента — никаких реальных сетевых вызовов.
const createMock = vi.fn()
vi.mock('@/lib/llm/client', () => ({
  getAnthropicClient: () => ({ messages: { create: createMock } }),
}))

import { parseWeeklySubmission } from './parser'

/**
 * Сейчас — понедельник 1 июня 2026, 10:00 МСК. Окно заявки: 06-01 … 06-15
 * (текущая и следующая неделя).
 */
const NOW = new Date('2026-06-01T07:00:00.000Z')
const context = { now: NOW, clientName: 'ООО Ромашка', locations: [{ id: 'loc_1', name: 'Офис' }] }

function toolUseResponse(input: unknown) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'submit_weekly_order', input }],
  }
}

const GOOD_INPUT = {
  items: [
    { date: '2026-06-01', portions: 20 },
    { date: '2026-06-02', portions: 18 },
  ],
  dietaryNotes: 'всегда 2 без свинины',
  confidence: 0.98,
  reason: 'таблица читается чётко',
}

describe('parseWeeklySubmission', () => {
  beforeEach(() => {
    createMock.mockReset()
  })

  it('text-вход: запрос содержит текст, форсированный tool + verный model, и маппит результат', async () => {
    createMock.mockResolvedValue(toolUseResponse(GOOD_INPUT))

    const result = await parseWeeklySubmission(
      { type: 'text', text: 'Пн 20, Вт 18' },
      context
    )

    expect(createMock).toHaveBeenCalledTimes(1)
    const req = createMock.mock.calls[0][0]

    // model === getVisionModel()
    expect(req.model).toBe(getVisionModel())

    // tool с правильным именем + tool_choice форсирует его
    expect(req.tools).toHaveLength(1)
    expect(req.tools[0].name).toBe('submit_weekly_order')
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'submit_weekly_order' })

    // content включает исходный текст
    const content = req.messages[0].content
    const textBlock = content.find((b: { type: string }) => b.type === 'text')
    expect(textBlock.text).toContain('Пн 20, Вт 18')

    // в system-промпте: clientName, сегодня с днём недели и конец окна (+14)
    expect(req.system).toContain('ООО Ромашка')
    expect(req.system).toContain('2026-06-01 (понедельник)')
    expect(req.system).toContain('2026-06-15')
    // одна точка — список точек в промпт не нужен
    expect(req.system).not.toContain('id=loc_1')

    // маппинг tool input → ParseResult (locationId не пришёл → null)
    expect(result.items).toEqual(GOOD_INPUT.items.map((i) => ({ ...i, locationId: null })))
    expect(result.dietaryNotes).toBe('всегда 2 без свинины')
    expect(result.confidence).toBe(0.98)
    expect(result.reason).toBe('таблица читается чётко')
  })

  it('photo-вход: content содержит image-блок с base64 и media_type', async () => {
    createMock.mockResolvedValue(toolUseResponse(GOOD_INPUT))

    await parseWeeklySubmission(
      { type: 'photo', base64: 'QkFTRTY0', mediaType: 'image/png' },
      context
    )

    const req = createMock.mock.calls[0][0]
    const content = req.messages[0].content
    const imageBlock = content.find((b: { type: string }) => b.type === 'image')
    expect(imageBlock).toBeTruthy()
    expect(imageBlock.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: 'QkFTRTY0',
    })
    // и текстовая инструкция рядом с картинкой
    expect(content.some((b: { type: string }) => b.type === 'text')).toBe(true)
  })

  it('несколько точек: список точек в промпте, locationId строки маппится', async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        ...GOOD_INPUT,
        items: [{ date: '2026-06-02', portions: 18, locationId: 'loc_2' }],
      }),
    )
    const result = await parseWeeklySubmission(
      { type: 'text', text: 'склад вт 18' },
      { ...context, locations: [{ id: 'loc_1', name: 'Офис' }, { id: 'loc_2', name: 'Склад' }] },
    )
    const req = createMock.mock.calls[0][0]
    expect(req.system).toContain('id=loc_2: Склад')
    expect(result.items).toEqual([{ date: '2026-06-02', portions: 18, locationId: 'loc_2' }])
  })

  it('маппинг: dietaryNotes=null сохраняется как null', async () => {
    createMock.mockResolvedValue(
      toolUseResponse({ ...GOOD_INPUT, dietaryNotes: null })
    )

    const result = await parseWeeklySubmission({ type: 'text', text: 'x' }, context)
    expect(result.dietaryNotes).toBeNull()
    expect(result.confidence).toBe(0.98)
  })

  it('malformed: ответ без tool_use блока → confidence 0 fallback', async () => {
    createMock.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'не смог распознать' }],
    })

    const result = await parseWeeklySubmission({ type: 'text', text: 'x' }, context)
    expect(result.confidence).toBe(0)
    expect(result.items).toEqual([])
    expect(result.dietaryNotes).toBeNull()
    expect(result.reason).toContain('parser failed')
  })

  it('malformed: tool input без числового confidence → confidence 0 fallback', async () => {
    createMock.mockResolvedValue(
      toolUseResponse({ items: [], dietaryNotes: null, reason: 'нет данных' })
    )

    const result = await parseWeeklySubmission({ type: 'text', text: 'x' }, context)
    expect(result.confidence).toBe(0)
    expect(result.reason).toContain('parser failed')
  })

  it('исключение из SDK → confidence 0 fallback (никогда не бросает наружу)', async () => {
    createMock.mockRejectedValue(new Error('429 overloaded'))

    const result = await parseWeeklySubmission({ type: 'text', text: 'x' }, context)
    expect(result.confidence).toBe(0)
    expect(result.reason).toContain('parser failed')
    expect(result.reason).toContain('429 overloaded')
  })
})
