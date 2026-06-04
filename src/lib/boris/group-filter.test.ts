import { describe, it, expect } from 'vitest'
import { mentionsBoris, resolveBorisAccess } from './group-filter'

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

describe('resolveBorisAccess (П4: доступ Бориса по chatType + наличию user)', () => {
  it('private + user есть → respond, требует identify, mutate разрешён (ярус role — дальше), персистим', () => {
    const a = resolveBorisAccess('private', true)
    expect(a).toEqual({
      respond: true,
      requireIdentify: true,
      canMutate: true,
      persistConversation: true,
    })
  })

  it('private + user=null → respond, requireIdentify=true (=> reply «не нашёл»), без mutate/персиста', () => {
    const a = resolveBorisAccess('private', false)
    expect(a.respond).toBe(true)
    expect(a.requireIdentify).toBe(true)
    expect(a.canMutate).toBe(false)
    expect(a.persistConversation).toBe(false)
  })

  it('group + user есть → respond, identify НЕ обязателен, mutate ЗАПРЕЩЁН в группе, персистим', () => {
    const a = resolveBorisAccess('group', true)
    expect(a).toEqual({
      respond: true,
      requireIdentify: false,
      canMutate: false,
      persistConversation: true,
    })
  })

  it('group + user=null → respond (НЕ «не нашёл»), read-only stateless, mutate запрещён', () => {
    const a = resolveBorisAccess('group', false)
    expect(a.respond).toBe(true)
    expect(a.requireIdentify).toBe(false) // не отвечаем «не нашёл»
    expect(a.canMutate).toBe(false)
    expect(a.persistConversation).toBe(false) // stateless: FK userId required → не персистим
  })

  it('supergroup ведёт себя как group', () => {
    expect(resolveBorisAccess('supergroup', false)).toEqual(resolveBorisAccess('group', false))
    expect(resolveBorisAccess('supergroup', true)).toEqual(resolveBorisAccess('group', true))
  })

  it('mutate в группе ЗАПРЕЩЁН всегда (и с user, и без)', () => {
    expect(resolveBorisAccess('group', true).canMutate).toBe(false)
    expect(resolveBorisAccess('group', false).canMutate).toBe(false)
    expect(resolveBorisAccess('supergroup', true).canMutate).toBe(false)
    expect(resolveBorisAccess('supergroup', false).canMutate).toBe(false)
  })

  it('channel / undefined → respond=false (не наша зона)', () => {
    expect(resolveBorisAccess('channel', false).respond).toBe(false)
    expect(resolveBorisAccess('channel', true).respond).toBe(false)
    expect(resolveBorisAccess(undefined, false).respond).toBe(false)
  })
})
