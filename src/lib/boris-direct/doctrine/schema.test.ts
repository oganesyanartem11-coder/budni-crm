import { describe, it, expect } from 'vitest'
import { DoctrineCardSchema, DOCTRINE_CLAIM_MAX } from './schema'

const base = {
  id: 'auction:1',
  claim: 'Списываемая цена в поиске считается по правилам VCG-аукциона, а не равна ставке.',
  type: 'MECHANIC' as const,
  source: { url: 'https://yandex.ru/support/direct/ru/technologies-and-services/vcg-auction', title: 'Как работает аукцион' },
  sourceTier: 'OFFICIAL_HELP' as const,
  tags: ['auction', 'price'],
  appliesTo: ['search' as const],
  confidence: 'HIGH' as const,
  projectStance: 'NEUTRAL' as const,
  status: 'ACTIVE' as const,
  addedAt: '2026-07-04',
  verifiedAt: '2026-07-04',
}

describe('DoctrineCardSchema', () => {
  it('валидная карточка проходит', () => {
    expect(DoctrineCardSchema.safeParse(base).success).toBe(true)
  })

  it('claim > 400 знаков — ошибка (защита от копипаста)', () => {
    const bad = { ...base, claim: 'я'.repeat(DOCTRINE_CLAIM_MAX + 1) }
    expect(DoctrineCardSchema.safeParse(bad).success).toBe(false)
  })

  it('битый url источника — ошибка', () => {
    const bad = { ...base, source: { url: 'not-a-url', title: 'x' } }
    expect(DoctrineCardSchema.safeParse(bad).success).toBe(false)
  })

  it('CONFLICTS без conflictNote — ошибка', () => {
    const bad = { ...base, projectStance: 'CONFLICTS' as const }
    const res = DoctrineCardSchema.safeParse(bad)
    expect(res.success).toBe(false)
    if (!res.success) expect(JSON.stringify(res.error.issues)).toContain('conflictNote')
  })

  it('CONFLICTS с conflictNote — проходит', () => {
    const ok = { ...base, projectStance: 'CONFLICTS' as const, conflictNote: 'Яндекс советует поднять бюджет — против нашего «не раздувать».' }
    expect(DoctrineCardSchema.safeParse(ok).success).toBe(true)
  })

  it('REFUTED_BY_EXPERIENCE без refutedBy — ошибка (аудит)', () => {
    const bad = { ...base, status: 'REFUTED_BY_EXPERIENCE' as const }
    const res = DoctrineCardSchema.safeParse(bad)
    expect(res.success).toBe(false)
    if (!res.success) expect(JSON.stringify(res.error.issues)).toContain('refutedBy')
  })

  it('REFUTED_BY_EXPERIENCE с refutedBy — проходит', () => {
    const ok = { ...base, status: 'REFUTED_BY_EXPERIENCE' as const, refutedBy: { lessonRef: 'lesson:abc', note: 'опыт кампании опроверг' } }
    expect(DoctrineCardSchema.safeParse(ok).success).toBe(true)
  })

  it('пустые tags / appliesTo — ошибка', () => {
    expect(DoctrineCardSchema.safeParse({ ...base, tags: [] }).success).toBe(false)
    expect(DoctrineCardSchema.safeParse({ ...base, appliesTo: [] }).success).toBe(false)
  })

  it('неизвестный type/appliesTo — ошибка', () => {
    expect(DoctrineCardSchema.safeParse({ ...base, type: 'FACT' }).success).toBe(false)
    expect(DoctrineCardSchema.safeParse({ ...base, appliesTo: ['tv'] }).success).toBe(false)
  })

  it('без sourceTier — ошибка (обязательное поле)', () => {
    const { sourceTier: _omit, ...noTier } = base
    expect(DoctrineCardSchema.safeParse(noTier).success).toBe(false)
    expect(DoctrineCardSchema.safeParse({ ...base, sourceTier: 'BLOG' }).success).toBe(false)
  })

  it('без verifiedAt — ошибка (обязательное поле)', () => {
    const { verifiedAt: _omit, ...noVerified } = base
    expect(DoctrineCardSchema.safeParse(noVerified).success).toBe(false)
  })

  it('sourceTier YARD валиден', () => {
    expect(DoctrineCardSchema.safeParse({ ...base, sourceTier: 'YARD' }).success).toBe(true)
  })
})
