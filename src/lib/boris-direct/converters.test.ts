import { describe, it, expect } from 'vitest'
import {
  CONFIRMED_CONVERTERS,
  isRegisteredConverter,
  normalizeConverterPhrase,
  converterLessonsForContext,
} from './converters'

describe('нормализация фразы конвертера', () => {
  it('lower + ё→е + операторы + пробелы', () => {
    expect(normalizeConverterPhrase('  Комплексные  ОБЕДЫ "с" +доставкой  ')).toBe(
      'комплексные обеды с доставкой'
    )
    expect(normalizeConverterPhrase('бизнес  лёнч')).toBe('бизнес ленч')
  })
})

describe('isRegisteredConverter', () => {
  it('5 подтверждённых конвертеров недели 1', () => {
    expect(CONFIRMED_CONVERTERS).toHaveLength(5)
  })

  it('распознаёт конвертер по нормализованному тексту (регистр/пробелы не важны)', () => {
    expect(isRegisteredConverter('корпоративное питание с доставкой москва')).toBe(true)
    expect(isRegisteredConverter('  Корпоративное   Питание С Доставкой Москва ')).toBe(true)
    expect(isRegisteredConverter('комплексные обеды с доставкой')).toBe(true)
    expect(isRegisteredConverter('обеды на заказ с доставкой в москве')).toBe(true)
  })

  it('не конвертер / пустое → false', () => {
    expect(isRegisteredConverter('доставка обедов благовещенск')).toBe(false)
    expect(isRegisteredConverter('')).toBe(false)
    expect(isRegisteredConverter(null)).toBe(false)
    expect(isRegisteredConverter(undefined)).toBe(false)
  })
})

describe('converterLessonsForContext', () => {
  it('по уроку на конвертер, kind=converter, с датой и «под защитой»', () => {
    const lessons = converterLessonsForContext()
    expect(lessons).toHaveLength(5)
    for (const l of lessons) {
      expect(l.kind).toBe('converter')
      expect(l.id.startsWith('converter:')).toBe(true)
      expect(l.text).toContain('КОНВЕРТЕР')
      expect(l.text.toLowerCase()).toContain('не минусовать')
    }
    const lost = lessons.find((l) => l.text.includes('корпоративное питание'))
    expect(lost?.text).toContain('03.07')
  })
})
