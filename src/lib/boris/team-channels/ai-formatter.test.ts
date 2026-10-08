import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/llm/client', () => ({ getAnthropicClient: vi.fn() }))
vi.mock('@/lib/ai/models', () => ({ getBorisModel: () => 'test-model' }))

import { sanitizeTelegramHtml, stripTelegramHtml } from './ai-formatter'

describe('sanitizeTelegramHtml', () => {
  it('разрешённые теги сохраняются', () => {
    const t = '<b>Итог</b>: <i>обед</i> <u>u</u> <s>s</s> <code>42</code>'
    expect(sanitizeTelegramHtml(t)).toBe(t)
  })

  it('ссылка с безопасной схемой сохраняется, & в href экранируется', () => {
    expect(sanitizeTelegramHtml('<a href="https://x.ru/?a=1&b=2">тут</a>')).toBe(
      '<a href="https://x.ru/?a=1&amp;b=2">тут</a>',
    )
    expect(sanitizeTelegramHtml("<a href='tg://user?id=1'>Артём</a>")).toBe(
      '<a href="tg://user?id=1">Артём</a>',
    )
  })

  it('javascript:/ссылка без href — текстом', () => {
    expect(sanitizeTelegramHtml('<a href="javascript:alert(1)">x</a>')).toBe(
      '&lt;a href="javascript:alert(1)"&gt;x&lt;/a&gt;',
    )
  })

  it('голые < > & и неподдерживаемые теги экранируются', () => {
    expect(sanitizeTelegramHtml('порций <5 & выручка >10к')).toBe('порций &lt;5 &amp; выручка &gt;10к')
    expect(sanitizeTelegramHtml('строка<br>ещё <p>абзац</p>')).toBe(
      'строка&lt;br&gt;ещё &lt;p&gt;абзац&lt;/p&gt;',
    )
    expect(sanitizeTelegramHtml('<b class="x">a</b>')).toBe('&lt;b class="x"&gt;a&lt;/b&gt;')
  })

  it('валидные сущности не двойным экранированием', () => {
    expect(sanitizeTelegramHtml('A &amp; B &lt;3 &#128578; &quot;q&quot;')).toBe(
      'A &amp; B &lt;3 &#128578; &quot;q&quot;',
    )
  })

  it('непарные закрывающие — текстом, незакрытые — закрываем', () => {
    expect(sanitizeTelegramHtml('a</b> <b>жирно')).toBe('a&lt;/b&gt; <b>жирно</b>')
    expect(sanitizeTelegramHtml('<b><i>x</b></i>')).toBe('<b><i>x&lt;/b&gt;</i></b>')
  })

  it('регистр тегов нормализуется', () => {
    expect(sanitizeTelegramHtml('<B>x</B>')).toBe('<b>x</b>')
  })
})

describe('stripTelegramHtml', () => {
  it('убирает теги и раскодирует сущности', () => {
    expect(
      stripTelegramHtml(sanitizeTelegramHtml('<b>Итог</b>: <5 & <a href="https://x.ru">ссылка</a> &#128578;')),
    ).toBe('Итог: <5 & ссылка 🙂')
  })
})
