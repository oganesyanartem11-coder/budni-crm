import { describe, expect, it } from 'vitest'
import { looksLikeDateRange } from './extract-delivery-date'

describe('looksLikeDateRange', () => {
  it.each([
    'с 7 по 14 +1 обед',
    'С 07 октября добавьте 1 полный обед',
    'с понедельника по пятницу по 30',
    'всю следующую неделю на 2 меньше',
    'до конца недели по 20',
    'каждый день по 15',
    'с 8.10 по 12.10 по 30',
  ])('период: %s', (text) => {
    expect(looksLikeDateRange(text)).toBe(true)
  })

  it.each(['30', 'завтра 25', 'Обед 75, завтрак и ужин 45', 'по 30 обедов', 'на пятницу 12', 'добавьте 2'])(
    'не период: %s',
    (text) => {
      expect(looksLikeDateRange(text)).toBe(false)
    },
  )
})
