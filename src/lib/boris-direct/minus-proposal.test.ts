import { describe, it, expect } from 'vitest'
import { buildDisputedMinusProposalDraft, type MinusCandidateStat } from './minus-proposal'
import type { MinusVerdictDraft } from './brain'

function stat(over: Partial<MinusCandidateStat> = {}): MinusCandidateStat {
  return { impressions: 31, clicks: 0, costRub: 0, ...over }
}

describe('buildDisputedMinusProposalDraft', () => {
  it('payload держит phrases (не words) + verdicts спорных; trigger по показам', () => {
    const verdicts: MinusVerdictDraft[] = [
      { candidate: 'фабрика обедов павловский посад', verdict: 'keep', reason: 'спорный' },
      { candidate: 'посторонняя фраза', verdict: 'minus', reason: 'мусор' },
    ]
    const statByQuery = new Map<string, MinusCandidateStat>([
      ['фабрика обедов павловский посад', stat({ impressions: 31 })],
    ])

    const draft = buildDisputedMinusProposalDraft(['фабрика обедов павловский посад'], verdicts, statByQuery)

    expect(draft.type).toBe('minus_words')
    expect(draft.topicKey).toBe('minus_words')
    const payload = draft.payload as { phrases: string[]; verdicts: MinusVerdictDraft[] }
    expect(payload.phrases).toEqual(['фабрика обедов павловский посад'])
    // verdicts отфильтрованы до спорных (только кандидаты из disputed).
    expect(payload.verdicts).toEqual([
      { candidate: 'фабрика обедов павловский посад', verdict: 'keep', reason: 'спорный' },
    ])
    expect(draft.triggerMetric).toBe('impressions_no_conversions')
    expect(draft.triggerValue).toBe(31)
    expect(draft.question).toBe('Занести в минусы?')
  })

  it('аргумент при расходе > 0: называет ₽ цифрой («съел X ₽ без заявок»)', () => {
    const statByQuery = new Map<string, MinusCandidateStat>([
      ['дорогая фраза', stat({ impressions: 120, clicks: 8, costRub: 640 })],
    ])

    const draft = buildDisputedMinusProposalDraft(
      ['дорогая фраза'],
      [{ candidate: 'дорогая фраза', verdict: 'keep', reason: 'спорный' }],
      statByQuery,
    )

    expect(draft.argument).toContain('120 показов, 8 кликов, 0 заявок')
    expect(draft.argument).toContain('Съел 640 ₽ без заявок')
    expect(draft.argument).toContain('больше заявок на рубль')
  })

  it('аргумент при 0 расхода / 0 кликов: НЕ обещает экономию, чистим релевантность', () => {
    const statByQuery = new Map<string, MinusCandidateStat>([
      ['фабрика обедов павловский посад', stat({ impressions: 31, clicks: 0, costRub: 0 })],
    ])

    const draft = buildDisputedMinusProposalDraft(
      ['фабрика обедов павловский посад'],
      [{ candidate: 'фабрика обедов павловский посад', verdict: 'keep', reason: 'спорный' }],
      statByQuery,
    )

    expect(draft.argument).toContain('31 показов, 0 кликов, 0 заявок')
    expect(draft.argument).toContain('Показы без интереса (0 кликов) — чистим релевантность')
    expect(draft.argument).not.toContain('уберёт нецелевой расход')
    expect(draft.argument).not.toMatch(/Съел .* ₽/)
  })
})
