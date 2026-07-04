import { describe, it, expect } from 'vitest'
import {
  selectDoctrine,
  renderDoctrineBlock,
  DOCTRINE_PREAMBLE,
  filterRefuted,
  renderKnowledgeExperienceConflicts,
} from './loader'
import type { DoctrineCard } from './schema'

function card(over: Partial<DoctrineCard>): DoctrineCard {
  return {
    id: over.id ?? 'x',
    claim: over.claim ?? 'claim',
    type: over.type ?? 'MECHANIC',
    source: over.source ?? { url: 'https://yandex.ru/support/direct/ru/x', title: 't' },
    tags: over.tags ?? ['auction'],
    appliesTo: over.appliesTo ?? ['search'],
    confidence: over.confidence ?? 'HIGH',
    projectStance: over.projectStance ?? 'NEUTRAL',
    conflictNote: over.conflictNote,
    status: over.status ?? 'ACTIVE',
    addedAt: over.addedAt ?? '2026-07-04',
    refutedBy: over.refutedBy,
  }
}

describe('selectDoctrine — отбор и приоритеты', () => {
  it('приоритет MECHANIC > LIMIT > RECOMMENDATION', () => {
    const cards = [
      card({ id: 'rec', type: 'RECOMMENDATION' }),
      card({ id: 'lim', type: 'LIMIT' }),
      card({ id: 'mech', type: 'MECHANIC' }),
    ]
    const out = selectDoctrine(cards, ['auction'])
    expect(out.map((c) => c.id)).toEqual(['mech', 'lim', 'rec'])
  })

  it('внутри типа HIGH перед MEDIUM', () => {
    const cards = [
      card({ id: 'med', type: 'MECHANIC', confidence: 'MEDIUM' }),
      card({ id: 'high', type: 'MECHANIC', confidence: 'HIGH' }),
    ]
    expect(selectDoctrine(cards, []).map((c) => c.id)).toEqual(['high', 'med'])
  })

  it('фильтр по тегам (пересечение); пустой tags = все', () => {
    const cards = [card({ id: 'a', tags: ['auction'] }), card({ id: 'b', tags: ['budget'] })]
    expect(selectDoctrine(cards, ['budget']).map((c) => c.id)).toEqual(['b'])
    expect(selectDoctrine(cards, []).length).toBe(2)
  })

  it('CONFLICTS исключены по умолчанию, включаются флагом', () => {
    const cards = [
      card({ id: 'ok' }),
      card({ id: 'conf', projectStance: 'CONFLICTS', conflictNote: 'против правила' }),
    ]
    expect(selectDoctrine(cards, []).map((c) => c.id)).toEqual(['ok'])
    expect(selectDoctrine(cards, [], { includeConflicts: true }).map((c) => c.id).sort()).toEqual(['conf', 'ok'])
  })

  it('REFUTED_BY_EXPERIENCE и STALE исключены ВСЕГДА (даже с includeConflicts)', () => {
    const cards = [
      card({ id: 'active' }),
      card({ id: 'ref', status: 'REFUTED_BY_EXPERIENCE', refutedBy: { lessonRef: 'l1' } }),
      card({ id: 'stale', status: 'STALE' }),
    ]
    expect(selectDoctrine(cards, [], { includeConflicts: true }).map((c) => c.id)).toEqual(['active'])
  })

  it('maxItems режет число карточек', () => {
    const cards = Array.from({ length: 10 }, (_, i) => card({ id: `c${i}` }))
    expect(selectDoctrine(cards, [], { maxItems: 3 }).length).toBe(3)
  })

  it('maxTokens: кэп соблюдается, но хотя бы одна карточка проходит', () => {
    const long = card({ id: 'long', claim: 'я'.repeat(390) })
    const short = card({ id: 'short', claim: 'коротко', type: 'LIMIT' })
    // Крошечный кэп — влезет только приоритетная (MECHANIC long), но минимум одна.
    const out = selectDoctrine([long, short], [], { maxTokens: 1 })
    expect(out.length).toBe(1)
    expect(out[0].id).toBe('long')
  })
})

describe('renderDoctrineBlock', () => {
  it('пустой набор → пустая строка', () => {
    expect(renderDoctrineBlock([])).toBe('')
  })

  it('преамбула + метки типов + пометка конфликта', () => {
    const block = renderDoctrineBlock([
      card({ claim: 'механика X' }),
      card({ claim: 'совет Y', type: 'RECOMMENDATION', projectStance: 'CONFLICTS', conflictNote: 'против «не раздувать бюджет»' }),
    ])
    expect(block).toContain('## СПРАВОЧНАЯ ДОКТРИНА')
    expect(block).toContain(DOCTRINE_PREAMBLE)
    expect(block).toContain('[МЕХАНИКА] механика X')
    expect(block).toContain('[СОВЕТ ЯНДЕКСА] совет Y [КОНФЛИКТ С НАШИМ ПРАВИЛОМ: против «не раздувать бюджет»]')
  })
})

describe('мост опыт↔доктрина (ШАГ 5)', () => {
  it('filterRefuted выбирает только REFUTED_BY_EXPERIENCE', () => {
    const cards = [
      card({ id: 'a' }),
      card({ id: 'ref', status: 'REFUTED_BY_EXPERIENCE', refutedBy: { lessonRef: 'lesson:x', note: 'опыт опроверг' } }),
      card({ id: 'stale', status: 'STALE' }),
    ]
    expect(filterRefuted(cards).map((c) => c.id)).toEqual(['ref'])
  })

  it('renderKnowledgeExperienceConflicts: заголовок + ссылка на урок; пусто → []', () => {
    expect(renderKnowledgeExperienceConflicts([])).toEqual([])
    const lines = renderKnowledgeExperienceConflicts([
      card({ claim: 'Яндекс: поднимайте ставки ради объёма', status: 'REFUTED_BY_EXPERIENCE', refutedBy: { lessonRef: 'lesson:42', note: 'рост ставки не дал заявок' } }),
    ])
    expect(lines[0]).toContain('КОНФЛИКТЫ ЗНАНИЕ/ОПЫТ')
    expect(lines[1]).toContain('опроверг урок lesson:42')
    expect(lines[1]).toContain('рост ставки не дал заявок')
  })
})
