import { describe, it, expect } from 'vitest'
import { getTeamBorisSystemPrompt } from './personality'
import type { DayContext } from './types'

// Минимальный контекст не влияет на текст промпта (он не инлайнится), поэтому
// достаточно любого валидного объекта-заглушки.
const CTX = {} as DayContext

describe('getTeamBorisSystemPrompt — нота о выручке (доставка как выручка)', () => {
  for (const channel of ['EVENING', 'FRIDAY', 'LIVE', 'ALERT'] as const) {
    const prompt = getTeamBorisSystemPrompt(channel, CTX)

    it(`[${channel}] содержит ноту «О ВЫРУЧКЕ» с упоминанием доставки`, () => {
      expect(prompt).toContain('О ВЫРУЧКЕ')
      expect(prompt).toMatch(/доставк/i)
    })

    it(`[${channel}] инструктирует считать маржу ТОЛЬКО по еде`, () => {
      expect(prompt).toMatch(/[Мм]аржу считай ТОЛЬКО по еде/)
    })

    it(`[${channel}] предупреждает про сравнение с прошлыми периодами`, () => {
      expect(prompt).toMatch(/раньше доставки в цифрах не было/)
    })

    it(`[${channel}] не выделять доставку отдельно в анализе`, () => {
      expect(prompt).toMatch(/[Оо]тдельно доставку в анализе НЕ выделяй/)
    })
  }
})
