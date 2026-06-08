import { describe, it, expect } from 'vitest'
import { mentionsBoris, resolveBorisAccess, shouldRespondInGroup } from './group-filter'

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

  describe('F-grp-3: матрица «Борис» + «Боря» и склонения', () => {
    const positive = [
      'Борис, проверь',
      'Боря, как заказ?',
      'Спросите у Бори',
      'передай Борису',
      'с Борисом',
      'Боря готов?',
      'позови Борю',
      'Борисе',
      'Борисы',
    ]
    const negative = [
      'борщ на обед',
      'борода длинная',
      'борьба идёт',
      'бор',
      'отбор кандидатов',
      'забор покрасили',
    ]

    it.each(positive)('срабатывает: %s', (text) => {
      expect(mentionsBoris(text)).toBe(true)
    })

    it.each(negative)('НЕ срабатывает: %s', (text) => {
      expect(mentionsBoris(text)).toBe(false)
    })
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

describe('shouldRespondInGroup (Boris reorg: 20-сообщений контекстное окно)', () => {
  // Пиним часы: tracker «только что» обновился, чтобы time-TTL не мешал
  // существующим кейсам про дистанцию.
  const NOW = 1_700_000_000_000
  const base = {
    chatId: -100,
    messageId: 100,
    lastBorisReplyMessageId: 95,
    lastBorisReplyAt: NOW,
    nowMs: NOW,
  }

  it('прямое упоминание «Борис» → should:true, direct_mention, Haiku не нужен', () => {
    expect(shouldRespondInGroup({ ...base, text: 'Борис, посчитай' })).toEqual({
      should: true,
      reason: 'direct_mention',
      needsHaiku: false,
    })
  })

  it('упоминание имеет приоритет даже без прошлого ответа Бориса', () => {
    expect(
      shouldRespondInGroup({
        ...base,
        text: 'спроси Бориса',
        lastBorisReplyMessageId: null,
        lastBorisReplyAt: null,
      }),
    ).toEqual({ should: true, reason: 'direct_mention', needsHaiku: false })
  })

  it('нет прошлого ответа Бориса (null) и без упоминания → should:false, no_prior_boris', () => {
    expect(
      shouldRespondInGroup({
        ...base,
        text: 'ребят, кто на обед',
        lastBorisReplyMessageId: null,
        lastBorisReplyAt: null,
      }),
    ).toEqual({ should: false, reason: 'no_prior_boris', needsHaiku: false })
  })

  it('в окне (дистанция ≤ 20, без упоминания) → should:true, in_window, needsHaiku:true', () => {
    expect(
      shouldRespondInGroup({ ...base, text: 'а если на 5 больше?', messageId: 110 }),
    ).toEqual({ should: true, reason: 'in_window', needsHaiku: true })
  })

  it('ровно на границе окна (дистанция = 20) → ещё в окне, needsHaiku:true', () => {
    expect(
      shouldRespondInGroup({ ...base, text: 'спасибо', messageId: 115 }),
    ).toEqual({ should: true, reason: 'in_window', needsHaiku: true })
  })

  it('дистанция > 20 → окно закрыто, should:false, window_closed, Haiku не нужен', () => {
    expect(
      shouldRespondInGroup({ ...base, text: 'что там по поставке', messageId: 116 }),
    ).toEqual({ should: false, reason: 'window_closed', needsHaiku: false })
  })
})

describe('shouldRespondInGroup (F-grp-2: time-TTL окна прослушки)', () => {
  const NOW = 1_700_000_000_000
  const base = {
    chatId: -100,
    messageId: 100,
    lastBorisReplyMessageId: 95, // дистанция 5 ≤ 20 — окно по дистанции открыто
    nowMs: NOW,
  }

  it('tracker обновлён 61 минуту назад, дистанция в окне, без упоминания → window_expired_by_time', () => {
    expect(
      shouldRespondInGroup({
        ...base,
        text: 'что там по обеду',
        lastBorisReplyAt: NOW - 61 * 60_000,
      }),
    ).toEqual({ should: false, reason: 'window_expired_by_time', needsHaiku: false })
  })

  it('tracker обновлён 59 минут назад → ещё в окне по времени, in_window, needsHaiku:true', () => {
    expect(
      shouldRespondInGroup({
        ...base,
        text: 'а если на 5 больше?',
        lastBorisReplyAt: NOW - 59 * 60_000,
      }),
    ).toEqual({ should: true, reason: 'in_window', needsHaiku: true })
  })

  it('прямое «Борис» при протухшем (61 мин) tracker → всё равно direct_mention (приоритет над TTL)', () => {
    expect(
      shouldRespondInGroup({
        ...base,
        text: 'Борис, посчитай',
        lastBorisReplyAt: NOW - 61 * 60_000,
      }),
    ).toEqual({ should: true, reason: 'direct_mention', needsHaiku: false })
  })
})
