import { describe, it, expect } from 'vitest'
import { DoctrineCardSchema } from './schema'
import { RAW_DOCTRINE } from './items'
import { getAllDoctrineCards, getDoctrine, getDoctrineBlock, estimateCardTokens } from './loader'

describe('доктрина: реальные карточки (ШАГ 7)', () => {
  it('ВСЕ карточки проходят схему', () => {
    const bad = RAW_DOCTRINE.map((c, i) => ({ i, id: (c as { id?: string })?.id, res: DoctrineCardSchema.safeParse(c) }))
      .filter((x) => !x.res.success)
      .map((x) => `#${x.i} ${x.id}: ${x.res.success ? '' : x.res.error.issues[0]?.message}`)
    expect(bad).toEqual([])
  })

  it('у каждой карточки заполнены sourceTier и verifiedAt (бэкфилл ШАГ 1)', () => {
    for (const c of getAllDoctrineCards()) {
      expect(['OFFICIAL_HELP', 'YARD', 'OTHER']).toContain(c.sourceTier)
      expect(c.verifiedAt.length).toBeGreaterThan(0)
    }
    // В базе есть карточки обоих источников (Справка + Ярд).
    const tiers = new Set(getAllDoctrineCards().map((c) => c.sourceTier))
    expect(tiers.has('OFFICIAL_HELP')).toBe(true)
    expect(tiers.has('YARD')).toBe(true)
  })

  it('id уникальны', () => {
    const ids = getAllDoctrineCards().map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('набор наполнен (ориентир 60–120 карточек)', () => {
    const n = getAllDoctrineCards().length
    expect(n).toBeGreaterThanOrEqual(60)
    expect(n).toBeLessThanOrEqual(160)
  })

  it('каждая CONFLICTS-карточка имеет непустой conflictNote', () => {
    for (const c of getAllDoctrineCards()) {
      if (c.projectStance === 'CONFLICTS') {
        expect(c.conflictNote && c.conflictNote.trim().length > 0).toBe(true)
      }
    }
  })

  it('каждая REFUTED_BY_EXPERIENCE-карточка ссылается на урок', () => {
    for (const c of getAllDoctrineCards()) {
      if (c.status === 'REFUTED_BY_EXPERIENCE') expect(c.refutedBy?.lessonRef).toBeTruthy()
    }
  })

  it('все источники — реальные http(s)-URL', () => {
    for (const c of getAllDoctrineCards()) {
      expect(c.source.url).toMatch(/^https?:\/\//)
    }
  })

  it('getDoctrine никогда не отдаёт REFUTED/STALE (даже с includeConflicts)', () => {
    const all = getDoctrine([], { maxItems: 9999, maxTokens: 9_999_999, includeConflicts: true })
    expect(all.every((c) => c.status === 'ACTIVE')).toBe(true)
  })

  it('токен-кэп соблюдается: сумма оценок ≤ кэпа (с запасом на 1 карточку)', () => {
    const cap = 500
    const sel = getDoctrine([], { maxItems: 50, maxTokens: cap })
    const sum = sel.reduce((n, c) => n + estimateCardTokens(c), 0)
    // Кэп соблюдается кроме гарантии «хотя бы одна карточка»: допускаем перебор
    // не больше самой крупной карточки.
    const maxCard = Math.max(...getAllDoctrineCards().map(estimateCardTokens))
    expect(sum).toBeLessThanOrEqual(cap + maxCard)
  })

  it('снапшот собранной доктрин-секции по теме budget (топ-4)', () => {
    const block = getDoctrineBlock(['budget'], { maxItems: 4, maxTokens: 5000 })
    expect(block).toContain('## СПРАВОЧНАЯ ДОКТРИНА')
    expect(block).toMatchSnapshot()
  })
})
