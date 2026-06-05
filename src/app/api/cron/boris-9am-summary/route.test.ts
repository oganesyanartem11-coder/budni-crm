import { describe, it, expect } from 'vitest'
import {
  buildNineAmSummary,
  borisPhraseForDay,
  type NineAmOrderRow,
} from '@/lib/boris/morning/nine-am-summary'

/**
 * П13 (MEGA-3): тесты текста утренней сводки «Сегодня на доставку».
 *
 * Тестируем чистую функцию buildNineAmSummary — DB-выборка и отправка в TG
 * живут в route.ts и здесь не воспроизводятся (статусная фильтрация
 * CONFIRMED/LOCKED/IN_PRODUCTION делается в роуте до вызова формирователя;
 * см. тест (б) — он проверяет, что переданные строки попадают в подсчёт,
 * а CANCELLED-заказ не передаётся и потому не считается).
 */

// Понедельник 2026-06-01, 06:00 UTC = 09:00 МСК.
const MONDAY_9AM_MSK = new Date('2026-06-01T06:00:00.000Z')

function row(partial: Partial<NineAmOrderRow> & { locationId: string }): NineAmOrderRow {
  return {
    locationName: partial.locationName ?? partial.locationId,
    portions: partial.portions ?? 0,
    totalPrice: partial.totalPrice ?? 0,
    ...partial,
  }
}

describe('buildNineAmSummary', () => {
  it('(а) формат строки локации «LocationName — N порций» и алфавитная сортировка', () => {
    const rows: NineAmOrderRow[] = [
      row({ locationId: 'b', locationName: 'Банк Восток', portions: 40, totalPrice: 20000 }),
      row({ locationId: 'a', locationName: 'Авангард', portions: 25, totalPrice: 12500 }),
    ]
    const text = buildNineAmSummary(rows, MONDAY_9AM_MSK)

    expect(text).toContain('Авангард — 25 порций')
    expect(text).toContain('Банк Восток — 40 порций')
    // Алфавитный порядок: Авангард раньше Банка.
    expect(text.indexOf('Авангард')).toBeLessThan(text.indexOf('Банк Восток'))
    // Шапка на месте.
    expect(text.startsWith('☀️ Доброе утро. Сегодня на доставку:')).toBe(true)
  })

  it('(б) считаются только переданные заказы (CANCELLED отфильтрован в роуте, не передан → не в подсчёте)', () => {
    // Имитируем результат роутовой фильтрации: CANCELLED-заказ на 99 порций
    // НЕ попал в rows. В итог должны войти только активные 30 порций.
    const rows: NineAmOrderRow[] = [
      row({ locationId: 'x', locationName: 'Сириус', portions: 30, totalPrice: 15000 }),
    ]
    const text = buildNineAmSummary(rows, MONDAY_9AM_MSK)

    expect(text).toContain('Сириус — 30 порций')
    expect(text).toContain('Итого: 30 порций')
    // Призрачный CANCELLED не должен нигде всплыть.
    expect(text).not.toContain('99')
  })

  it('(в) итог: суммирует порции и ₽ по всем локациям, локации одной точки складываются', () => {
    const rows: NineAmOrderRow[] = [
      row({ locationId: 'a', locationName: 'Авангард', portions: 10, totalPrice: 5000 }),
      // Тот же locationId — обед+ужин на одной точке → одна строка, сумма.
      row({ locationId: 'a', locationName: 'Авангард', portions: 5, totalPrice: 2500 }),
      row({ locationId: 'b', locationName: 'Банк Восток', portions: 20, totalPrice: 10000 }),
    ]
    const text = buildNineAmSummary(rows, MONDAY_9AM_MSK)

    // Авангард: 10+5 = 15 порций, одна строка.
    expect(text).toContain('Авангард — 15 порций')
    expect((text.match(/Авангард/g) ?? []).length).toBe(1)
    // Итог: 15 + 20 = 35 порций, 5000+2500+10000 = 17500 → «17 500 ₽».
    expect(text).toContain('Итого: 35 порций, 17 500 ₽')
  })

  it('пустой день — сообщает, что заказов нет, но шапку и фразу сохраняет', () => {
    const text = buildNineAmSummary([], MONDAY_9AM_MSK)
    expect(text).toContain('Заказов на сегодня пока нет')
    expect(text.startsWith('☀️ Доброе утро. Сегодня на доставку:')).toBe(true)
  })

  it('Волна 4: deliveryRevenue>0 добавляет строку «Доставка: X ₽»; food-итог не меняется', () => {
    const rows: NineAmOrderRow[] = [
      row({ locationId: 'a', locationName: 'Авангард', portions: 10, totalPrice: 5000 }),
    ]
    const text = buildNineAmSummary(rows, MONDAY_9AM_MSK, (s) => s, 1200)
    // food-итог как был.
    expect(text).toContain('Итого: 10 порций, 5 000 ₽')
    // отдельная строка доставки.
    expect(text).toContain('Доставка: 1 200 ₽')
  })

  it('Волна 4: deliveryRevenue=0 → строки доставки нет', () => {
    const rows: NineAmOrderRow[] = [
      row({ locationId: 'a', locationName: 'Авангард', portions: 10, totalPrice: 5000 }),
    ]
    const text = buildNineAmSummary(rows, MONDAY_9AM_MSK, (s) => s, 0)
    expect(text).not.toContain('Доставка:')
  })
})

describe('borisPhraseForDay (ротация по дню недели МСК, детерминированно)', () => {
  it('понедельник → первая фраза набора', () => {
    expect(borisPhraseForDay(MONDAY_9AM_MSK)).toBe('День будет насыщенный')
  })

  it('стабильна для одного дня (не Math.random)', () => {
    expect(borisPhraseForDay(MONDAY_9AM_MSK)).toBe(borisPhraseForDay(MONDAY_9AM_MSK))
  })

  it('учитывает МСК-смещение: 23:30 UTC вс = уже понедельник МСК', () => {
    // Вс 2026-05-31 23:30 UTC = Пн 2026-06-01 02:30 МСК.
    const lateSundayUtc = new Date('2026-05-31T23:30:00.000Z')
    expect(borisPhraseForDay(lateSundayUtc)).toBe('День будет насыщенный')
  })
})
