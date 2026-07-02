import { describe, it, expect } from 'vitest'
import { getBorisDirectSystemPrompt } from './prompts'
import {
  BORIS_VOICE_BLOCK,
  BORIS_TELEGRAM_FORMAT_BLOCK,
  getBorisSystemPrompt,
} from '@/lib/boris/personality'

describe('getBorisDirectSystemPrompt — переиспользование личности', () => {
  const observe = getBorisDirectSystemPrompt({ mode: 'OBSERVE', frozen: false })
  const live = getBorisDirectSystemPrompt({ mode: 'LIVE', frozen: false })
  const frozen = getBorisDirectSystemPrompt({ mode: 'LIVE', frozen: true })

  it('включает общий voice-блок Бориса байт-в-байт (личность не форкается)', () => {
    expect(observe).toContain(BORIS_VOICE_BLOCK)
    expect(observe).toContain(BORIS_TELEGRAM_FORMAT_BLOCK)
  })

  it('CRM-промпт Бориса не изменился от выделения voice-блока', () => {
    // Смоук: основной промпт по-прежнему содержит голос и запрет markdown.
    const crm = getBorisSystemPrompt()
    expect(crm).toContain(BORIS_VOICE_BLOCK)
    expect(crm).toContain(BORIS_TELEGRAM_FORMAT_BLOCK)
  })

  it('north star: максимум заявок на рубль, не клики', () => {
    expect(observe).toMatch(/МАКСИМУМ ЗАЯВОК на рубль/i)
    expect(observe).toMatch(/минимально возможных расходах/i)
  })

  it('observe: формулировки «что БЫ сделал», пишущие запросы не уходят', () => {
    expect(observe).toMatch(/что БЫ я сделал/i)
    expect(observe).toMatch(/ни один пишущий запрос/i)
    expect(observe).toMatch(/Боевой режим включает только владелец/i)
  })

  it('live: пишет что СДЕЛАЛ', () => {
    expect(live).toMatch(/Боевой режим/i)
    expect(live).toMatch(/СДЕЛАЛ/)
  })

  it('стоп-кран перекрывает live', () => {
    expect(frozen).toMatch(/Стоп-кран активен/i)
    expect(frozen).not.toMatch(/реально применяются/i)
  })

  it('запрещает выдумывать цифры (арифметика — в коде)', () => {
    expect(observe).toMatch(/ЦИФРЫ НЕ ВЫДУМЫВАТЬ/i)
  })

  it('бюджет меняет только владелец; режимы — командами через код', () => {
    expect(observe).toMatch(/меняет только владелец/i)
    expect(observe).toMatch(/обрабатывает код/i)
  })
})
