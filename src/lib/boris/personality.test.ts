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

describe('getBorisSystemPrompt — #4 динамический контекст-блок', () => {
  // Изолируем именно динамический КОНТЕКСТ-БЛОК (## ТЕКУЩИЙ КОНТЕКСТ ... Кто ты:),
  // т.к. фразы отказа живут и в статичном Правиле Г — на полном промпте их не
  // различить. Блок берём от заголовка до начала «Кто ты:».
  function contextBlockOf(p: string): string {
    const start = p.indexOf('## ТЕКУЩИЙ КОНТЕКСТ')
    if (start === -1) return ''
    const end = p.indexOf('Кто ты:', start)
    return p.slice(start, end === -1 ? undefined : end)
  }

  it('без ctx — блок не инжектится (старое поведение)', () => {
    expect(getBorisSystemPrompt()).not.toContain('## ТЕКУЩИЙ КОНТЕКСТ')
  })

  it('canMutate=true (личка+ADMIN_PRO) — явно разрешает mutate, запрещает отказ про группу', () => {
    const block = contextBlockOf(
      getBorisSystemPrompt({ canMutate: true, chatType: 'private', isAdminPro: true })
    )
    expect(block).toMatch(/РАЗРЕШЕНЫ/)
    expect(block).toMatch(/НЕ отказывай/i)
  })

  it('canMutate=false + группа — детерминированная причина «только в личной переписке»', () => {
    const block = contextBlockOf(
      getBorisSystemPrompt({ canMutate: false, chatType: 'group', isAdminPro: false })
    )
    expect(block).toMatch(/только в личной переписке со мной/i)
    expect(block).not.toMatch(/только администратору/i)
  })

  it('canMutate=false + личка не-ADMIN_PRO — детерминированная причина «только администратору»', () => {
    const block = contextBlockOf(
      getBorisSystemPrompt({ canMutate: false, chatType: 'private', isAdminPro: false })
    )
    expect(block).toMatch(/только администратору/i)
    expect(block).not.toMatch(/только в личной переписке со мной/i)
  })
})
