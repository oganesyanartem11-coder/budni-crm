import { describe, it, expect } from 'vitest'
import { extractNumbers, validateGrounding } from './analyst-ground'

describe('extractNumbers', () => {
  it('вытаскивает целые и дробные (запятая и точка), проценты и ₽', () => {
    expect(extractNumbers('клик 831 ₽, CR 7.96%, ниже входа 12,5%')).toEqual([831, 7.96, 12.5])
  })
  it('пустая строка → пусто', () => {
    expect(extractNumbers('нет чисел тут')).toEqual([])
  })
})

describe('validateGrounding', () => {
  const dash =
    'ДНИ:\n- 2026-07-09: 800 ₽ / 10 / 0 / —\nЛЕСЕНКА: медиана входа 95 ₽; ниже входа 20%.\n' +
    'ДЕТЕКТОРЫ: исторической конверсии 7.96% вероятность нуля 0.30%.'

  it('все числа из дашборда → grounded', () => {
    const out = 'Расход 800 ₽ при 10 кликах и 0 заявок; медиана входа 95 ₽.'
    const r = validateGrounding(out, dash)
    expect(r.grounded).toBe(true)
    expect(r.ungrounded).toEqual([])
  })

  it('выдуманное число (нет в дашборде) → not grounded, оно в списке', () => {
    const out = 'Цена заявки взлетела до 340 ₽.'
    const r = validateGrounding(out, dash)
    expect(r.grounded).toBe(false)
    expect(r.ungrounded).toContain(340)
  })

  it('округление в пределах допуска заземлено (7.96% → «8%»)', () => {
    const r = validateGrounding('конверсия упала до 8%', dash)
    expect(r.grounded).toBe(true)
  })

  it('структурные малые целые (0..3) заземлены всегда (нумерация/малые счётчики)', () => {
    const r = validateGrounding('гипотеза 1: ноль заявок 3 дня подряд', 'дашборд без этих чисел')
    expect(r.grounded).toBe(true)
  })

  it('даты из дашборда заземлены (09.07 ← 2026-07-09)', () => {
    const r = validateGrounding('обрыв с 09.07', dash)
    expect(r.grounded).toBe(true)
  })

  it('несколько выдуманных чисел все попадают в список', () => {
    const r = validateGrounding('CPL 340 ₽, потолок пробит до 1200 ₽', dash)
    expect(r.ungrounded).toContain(340)
    expect(r.ungrounded).toContain(1200)
  })
})
