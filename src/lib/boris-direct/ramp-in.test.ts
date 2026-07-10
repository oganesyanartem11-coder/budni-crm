import { describe, it, expect } from 'vitest'
import { selectRampInSubset, formatCbStoppedPlan, type EnrichedChange } from './ramp-in'
import { checkCircuitBreaker } from './rules'
import { MICRO, CB_MAX_BID_CHANGES_PER_TICK } from './config'

function ch(
  keywordId: number,
  fromRub: number,
  toRub: number,
  opts: Partial<Pick<EnrichedChange, 'verdict' | 'confidence' | 'protectedConv' | 'isExploration'>> = {}
): EnrichedChange {
  const verdict = opts.verdict ?? (toRub >= fromRub ? 'promote' : 'demote')
  return {
    keywordId,
    fromMicro: fromRub * MICRO,
    toMicro: toRub * MICRO,
    verdict,
    confidence: opts.confidence ?? 0.7,
    protectedConv: opts.protectedConv ?? false,
    isExploration: opts.isExploration ?? false,
  }
}

describe('selectRampInSubset — ввод портфеля порциями строго ПОД circuit breaker', () => {
  it('план целиком проходит CB → применяем всё, остатка нет', () => {
    const plan = [ch(1, 100, 90), ch(2, 100, 95), ch(3, 100, 92)]
    const r = selectRampInSubset(plan)
    expect(r.apply.length).toBe(3)
    expect(r.deferred.length).toBe(0)
    expect(checkCircuitBreaker(r.apply).ok).toBe(true)
  })

  it('перебор по КОЛИЧЕСТВУ (>40) → применяем ровно лимит, остаток в defer', () => {
    // 50 демоутов (снижают массу → mass-shift не трогает; бьёт только счётчик).
    const plan = Array.from({ length: 50 }, (_, i) => ch(i + 1, 100, 95))
    const r = selectRampInSubset(plan)
    expect(r.apply.length).toBe(CB_MAX_BID_CHANGES_PER_TICK) // 40
    expect(r.deferred.length).toBe(10)
    expect(checkCircuitBreaker(r.apply).ok).toBe(true)
  })

  it('подмножество ВСЕГДА проходит CB (mass-shift не превышен)', () => {
    // 5 демоутов (запас массы) + 10 крупных подъёмов конвертеров 100→260 (+160% each).
    const demotes = Array.from({ length: 5 }, (_, i) => ch(i + 1, 100, 90))
    const raises = Array.from({ length: 10 }, (_, i) =>
      ch(100 + i, 100, 260, { verdict: 'promote', protectedConv: i < 2, isExploration: i >= 2, confidence: 0.9 })
    )
    const r = selectRampInSubset([...demotes, ...raises])
    // Гарантия безопасности: что применяем — то CB пропускает.
    expect(checkCircuitBreaker(r.apply).ok).toBe(true)
    // Часть подъёмов не влезла под mass-cap → защита сработала, остаток есть.
    expect(r.deferred.length).toBeGreaterThan(0)
    // apply ∪ deferred == план (ничего не потеряли).
    expect(r.apply.length + r.deferred.length).toBe(15)
  })

  it('ПРИОРИТЕТ: реестровые/доказанные конвертеры вперёд exploration-хвоста', () => {
    // Запас массы демоутами, затем 1 конвертер и 1 exploration крупного подъёма —
    // при жёстком mass-cap влезет приоритетный (конвертер), exploration уйдёт в defer.
    const demotes = Array.from({ length: 3 }, (_, i) => ch(i + 1, 100, 90))
    const converter = ch(200, 100, 260, { verdict: 'promote', protectedConv: true, confidence: 0.95 })
    const exploration = ch(300, 100, 260, { verdict: 'promote', isExploration: true, confidence: 0.55 })
    const r = selectRampInSubset([...demotes, exploration, converter]) // exploration подан РАНЬШЕ в массиве
    const appliedIds = new Set(r.apply.map((c) => c.keywordId))
    // Конвертер должен войти раньше exploration независимо от порядка на входе.
    expect(appliedIds.has(200)).toBe(true)
    if (r.deferred.length > 0) {
      // Если что-то отложено — это exploration, не конвертер.
      expect(r.deferred.every((c) => !c.protectedConv)).toBe(true)
    }
    expect(checkCircuitBreaker(r.apply).ok).toBe(true)
  })

  it('демоуты (снижение массы) применяются всегда — они безопасны и освобождают запас', () => {
    const demotes = Array.from({ length: 10 }, (_, i) => ch(i + 1, 100, 85))
    const r = selectRampInSubset(demotes)
    expect(r.apply.length).toBe(10)
    expect(r.deferred.length).toBe(0)
  })

  it('пустой план → пусто', () => {
    const r = selectRampInSubset([])
    expect(r.apply.length).toBe(0)
    expect(r.deferred.length).toBe(0)
  })

  it('ВЕСЬ план проходит CB → применяем ЦЕЛИКОМ (нет инверсии приоритета, нейтральность к базе)', () => {
    // Кейс ревью: приоритетный конвертер с крупным ОТНОСИТЕЛЬНЫМ подъёмом + разбавляющие
    // правки с большой базой. ПОЛНЫЙ план проходит CB (+9%), значит применяем ВСЁ —
    // без prefix-жадности, которая иначе отложила бы конвертер (немонотонность mass-ratio
    // на тонком префиксе) и применила менее приоритетные (инверсия + расхождение с базой).
    const demote = ch(1, 20, 10)
    const converter = ch(2, 20, 200, { verdict: 'promote', protectedConv: true, confidence: 0.95 })
    const dilute = Array.from({ length: 12 }, (_, i) =>
      ch(100 + i, 200, 205, { verdict: 'promote', isExploration: true })
    )
    const plan = [demote, converter, ...dilute]
    // Санити: полный план ДЕЙСТВИТЕЛЬНО проходит CB.
    expect(
      checkCircuitBreaker(plan.map((c) => ({ keywordId: c.keywordId, fromMicro: c.fromMicro, toMicro: c.toMicro }))).ok
    ).toBe(true)
    const r = selectRampInSubset(plan)
    expect(r.deferred.length).toBe(0) // ничего не отложено
    expect(r.apply.length).toBe(plan.length) // применили всё
    expect(r.apply.some((c) => c.keywordId === 2)).toBe(true) // конвертер ВНУТРИ, не инвертирован
  })
})

describe('formatCbStoppedPlan — содержательный CB-алерт (немой стоп запрещён как класс)', () => {
  it('сводка остановленного плана: вверх/вниз, диапазон Δ, топ по |Δ| с вердиктом', () => {
    const text = formatCbStoppedPlan({
      changes: [
        { keyText: 'питания для рабочих', fromMicro: 156 * MICRO, toMicro: 336 * MICRO, verdict: 'promote' },
        { keyText: 'обеды для рабочих', fromMicro: 116 * MICRO, toMicro: 265 * MICRO, verdict: 'promote' },
        { keyText: 'горелка пустая', fromMicro: 100 * MICRO, toMicro: 85 * MICRO, verdict: 'demote' },
      ],
    })
    expect(text).toContain('вверх: 2')
    expect(text).toContain('вниз: 1')
    expect(text).toContain('«питания для рабочих»') // топ по |Δ|=180
    expect(text).toContain('156')
    expect(text).toContain('336')
    expect(text).toContain('подъём')
    expect(text).toContain('вниз')
  })
  it('пустой план не падает', () => {
    expect(() => formatCbStoppedPlan({ changes: [] })).not.toThrow()
  })
})
