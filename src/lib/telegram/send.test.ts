import { describe, it, expect } from 'vitest'
import { splitForTelegram, TELEGRAM_MAX_LEN } from './send'

describe('splitForTelegram — разбивка длинных сообщений (лимит 4096, смысл НЕ режем)', () => {
  it('текст ≤ лимита → одна часть без изменений', () => {
    expect(splitForTelegram('короткое сообщение')).toEqual(['короткое сообщение'])
  })

  it('текст > лимита → несколько частей ≤ лимита, весь контент сохранён, без «…»', () => {
    const line = 'Строка вопроса аналитика с каузальной цепочкой и предложением.'
    const text = Array.from({ length: 300 }, (_, i) => `${i}) ${line}`).join('\n')
    expect(text.length).toBeGreaterThan(TELEGRAM_MAX_LEN)

    const parts = splitForTelegram(text)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX_LEN)
    // Режем по границам строк и склеиваем обратно тем же \n — контент байт-в-байт на месте.
    expect(parts.join('\n')).toBe(text)
    expect(parts.join('')).not.toContain('…')
  })

  it('единственная строка длиннее лимита (патология) → жёсткая нарезка без потери символов', () => {
    const huge = 'x'.repeat(TELEGRAM_MAX_LEN * 2 + 5)
    const parts = splitForTelegram(huge)
    expect(parts.length).toBe(3)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX_LEN)
    expect(parts.join('')).toBe(huge)
  })
})
