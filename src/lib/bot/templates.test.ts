import { describe, it, expect } from 'vitest'
import { formatUpdatedReply, type SavedItemForReply } from './templates'

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
