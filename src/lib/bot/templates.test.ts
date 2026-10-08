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

describe('formatAcceptedReply — приёмы пищи вместо «Повадино — 75, Повадино — 75…»', () => {
  it('одна точка, три приёма → подписи приёмами', async () => {
    const { formatAcceptedReply } = await import('./templates')
    expect(
      formatAcceptedReply([
        { locationName: 'Повадино', portions: 75, mealType: 'LUNCH' },
        { locationName: 'Повадино', portions: 45, mealType: 'BREAKFAST' },
        { locationName: 'Повадино', portions: 45, mealType: 'DINNER' },
      ]),
    ).toBe('Принято: обед — 75, завтрак — 45, ужин — 45. Спасибо!')
  })

  it('две точки, один приём → подписи точками', async () => {
    const { formatAcceptedReply } = await import('./templates')
    expect(
      formatAcceptedReply([
        { locationName: 'Офис', portions: 10, mealType: 'LUNCH' },
        { locationName: 'Склад', portions: 5, mealType: 'LUNCH' },
      ]),
    ).toBe('Принято: Офис — 10, Склад — 5. Спасибо!')
  })
})

describe('getReminder14Text — «на завтра» только если доставка завтра (МСК)', () => {
  it('пятница → понедельник: не «на завтра», а дата', async () => {
    const { getReminder14Text } = await import('./templates')
    // пн 18.05.2026 (18 % 7 = 4 → вариант с датой), отправка пт 15.05 14:00 МСК.
    const monday = new Date('2026-05-18T00:00:00Z')
    const fridayNow = new Date('2026-05-15T11:00:00Z')
    const text = getReminder14Text(monday, fridayNow)
    expect(text).not.toContain('завтра')
    expect(text).toBe('Сколько порций готовим на 18.05?')
  })

  it('доставка завтра → «на завтра»', async () => {
    const { getReminder14Text } = await import('./templates')
    const thu = new Date('2026-06-04T00:00:00Z')
    const wedNow = new Date('2026-06-03T11:00:00Z')
    expect(getReminder14Text(thu, wedNow)).toBe('Сколько порций готовим на завтра?')
  })

  it('без now — не утверждаем «завтра»', async () => {
    const { getReminder14Text } = await import('./templates')
    expect(getReminder14Text(new Date('2026-06-04T00:00:00Z'))).toBe('Сколько порций готовим на 04.06?')
  })

  it('ни один вариант вопроса/напоминаний не говорит «завтра» про пн из пятницы', async () => {
    const { getReminder14Text, getReminder1530Text } = await import('./templates')
    const fridayNow = new Date('2026-05-15T11:00:00Z')
    for (let d = 18; d < 25; d++) {
      const delivery = new Date(Date.UTC(2026, 4, d))
      expect(getReminder14Text(delivery, fridayNow)).not.toContain('завтра')
      expect(getReminder1530Text(delivery)).not.toContain('завтра')
      expect(getDailyQuestionText(delivery, fridayNow)).not.toContain('завтра')
    }
  })
})
