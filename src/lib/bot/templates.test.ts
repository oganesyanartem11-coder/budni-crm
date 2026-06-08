import { describe, it, expect } from 'vitest'
import { formatUpdatedReply, getDailyQuestionText, type SavedItemForReply } from './templates'

/**
 * П8: повтор того же заказа без изменений не должен давать пустой
 * «Принято, обновили: .». Пустой список → отдельный текст «Принято, без
 * изменений.». Одиночный/множественный список форматируются как раньше.
 */
describe('formatUpdatedReply (КЕЙС B, П8)', () => {
  it('пустой список → «Принято, без изменений.»', () => {
    expect(formatUpdatedReply([])).toBe('Принято, без изменений.')
  })

  it('один элемент → «Принято, обновили на N порций.»', () => {
    const items: SavedItemForReply[] = [{ locationName: 'Офис', portions: 10 }]
    expect(formatUpdatedReply(items)).toBe('Принято, обновили на 10 порций.')
  })

  it('несколько элементов → «Принято, обновили: ...» со списком', () => {
    const items: SavedItemForReply[] = [
      { locationName: 'Офис', portions: 10 },
      { locationName: 'Склад', portions: 5 },
    ]
    expect(formatUpdatedReply(items)).toBe('Принято, обновили: Офис — 10, Склад — 5.')
  })
})

describe('getDailyQuestionText — персональный cut-off в шапке (7.51 F-A)', () => {
  // 2026-06-08T00:00:00Z → в МСК это пн 08.06 03:00 (getDay=1) → isReminderDay.
  const mondayMsk = new Date('2026-06-08T00:00:00Z')
  const delivery = new Date('2026-06-08T00:00:00Z')

  it('передан cutoffStr → шапка использует его вместо 16:00', () => {
    const text = getDailyQuestionText(delivery, mondayMsk, '08:40')
    expect(text).toContain('Ожидаем заявку до 08:40')
    expect(text).not.toContain('до 16:00')
  })

  it('cutoffStr не передан → шапка использует глобальный «до 16:00»', () => {
    const text = getDailyQuestionText(delivery, mondayMsk)
    expect(text).toContain('Ожидаем заявку до 16:00')
  })
})
