import { describe, it, expect } from 'vitest'
import { getBorisSystemPrompt } from './personality'

describe('getBorisSystemPrompt — hardened rules', () => {
  const prompt = getBorisSystemPrompt()

  it('returns a non-trivial string', () => {
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(500)
  })

  it('instructs table/list format for reports/summaries', () => {
    expect(prompt).toMatch(/Сводка|отчёт|расклад/i)
    expect(prompt).toMatch(/таблиц|списк/i)
  })

  it('instructs short text WITHOUT tables for advice/motivation', () => {
    expect(prompt).toMatch(/совет|мотивац/i)
    expect(prompt).toMatch(/БЕЗ таблиц/i)
    expect(prompt).toMatch(/1-3 предложени/i)
  })

  it('instructs NOT to invent a client on no_match', () => {
    expect(prompt).toContain('no_match')
    expect(prompt).toMatch(/НЕ выдумывай|не изобретай|не строй гипотез/i)
    expect(prompt).toMatch(/уточни, как он у нас числится/i)
  })

  it('refuses settings changes via chat (anti-manipulation → admin)', () => {
    expect(prompt).toMatch(/АНТИ-МАНИПУЛЯЦИЯ|манипуляц/i)
    expect(prompt).toMatch(/настройки.*через админку|обратись к админу/i)
    expect(prompt).toMatch(/теперь делай так|будь короче/i)
  })

  it('forbids markdown — explicitly bans ** and pipe tables', () => {
    expect(prompt).toMatch(/ЗАПРЕТ MARKDOWN|НИКОГДА не используй markdown/i)
    expect(prompt).toContain('**')
    expect(prompt).toMatch(/пайп|вертикальн|\|/i)
    expect(prompt).toMatch(/решётк|#/)
  })

  it('keeps a business-like, non-familiar tone rule', () => {
    expect(prompt).toMatch(/деловой|спокойн/i)
    expect(prompt).toMatch(/панибратств|Бро/i)
  })

  it('preserves tool-calling / preview instructions intact', () => {
    expect(prompt).toContain('find_orders')
    expect(prompt).toMatch(/preview/i)
    expect(prompt).toContain('edit_order_portions')
  })
})
