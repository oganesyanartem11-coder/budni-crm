import { describe, it, expect } from 'vitest'
import { mentionsBoris } from './group-filter'

describe('mentionsBoris', () => {
  it('срабатывает на адресное обращение в начале', () => {
    expect(mentionsBoris('Борис, привет')).toBe(true)
    expect(mentionsBoris('Борис подскажи')).toBe(true)
    expect(mentionsBoris('БОРИС!')).toBe(true)
  })

  it('срабатывает на склонения', () => {
    expect(mentionsBoris('спроси Бориса')).toBe(true)
    expect(mentionsBoris('передай Борису что готово')).toBe(true)
    expect(mentionsBoris('говорил с Борисом вчера')).toBe(true)
  })

  it('срабатывает в любом месте текста', () => {
    expect(mentionsBoris('а что Борис скажет')).toBe(true)
    expect(mentionsBoris('нам Борис нужен')).toBe(true)
    expect(mentionsBoris('привет всем, и Борис тоже')).toBe(true)
  })

  it('НЕ срабатывает на части других слов', () => {
    expect(mentionsBoris('борисович приехал')).toBe(false)
    expect(mentionsBoris('Borisbot выключен')).toBe(false)
    expect(mentionsBoris('борисfoo')).toBe(false)
  })

  it('НЕ срабатывает на пустую строку или текст без упоминания', () => {
    expect(mentionsBoris('')).toBe(false)
    expect(mentionsBoris('просто чат без упоминаний')).toBe(false)
    expect(mentionsBoris('сириус +1 на четверг')).toBe(false)
  })

  it('работает с пунктуацией и эмодзи', () => {
    expect(mentionsBoris('Борис!!!')).toBe(true)
    expect(mentionsBoris('🎉 Борис, поздравляю')).toBe(true)
    expect(mentionsBoris('— Борис')).toBe(true)
  })
})
