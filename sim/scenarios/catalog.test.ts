/**
 * Тесты КАТАЛОГА СЦЕНАРИЕВ полигона Бориса-Директа (sim/scenarios/catalog.ts).
 *
 * Проверяют ФАКТИЧЕСКИЙ каталог, который строит buildCatalog(baseSeed):
 * состав, уникальность id, инварианты каждого сценария, честность
 * expectations, обобщение holdout (незнакомые типы событий), наличие
 * memory-сценариев и детерминизм по baseSeed.
 *
 * Ни сети, ни Math.random/Date — только чистый buildCatalog. Тест не правит
 * каталог: если находит расхождение с планом — фиксирует реальностью.
 *
 * Фактический состав (проверено по catalog.ts):
 *   24 tuning (T01–T24) + 6 holdout (H01–H06) = 30 сценариев.
 *   Здоровая кампания (пустой план) — T01.
 *   Событийные kind ТОЛЬКО в holdout: competitor_brand_attack (H04),
 *   fake_leads_wave (H05). H06 комбинирует уже знакомые auction_drift +
 *   demand_dip (новизна там — в СМЕСИ, а не в kind).
 *   Memory-сценарии (regime_change): T19 (G2), H02 (G1).
 */

import { describe, expect, it } from 'vitest'
import type { ScenarioConfig, WorldEvent } from '../types'
import { REASON_CODES } from '../../src/lib/boris-direct/reason-codes'
import { buildCatalog } from './catalog'

const catalog = buildCatalog(1)
const REASON_CODE_SET = new Set<string>(REASON_CODES)

/** Множество kind событий, встречающихся в наборе сценариев. */
function eventKinds(scns: ScenarioConfig[]): Set<WorldEvent['kind']> {
  const s = new Set<WorldEvent['kind']>()
  for (const scn of scns) for (const e of scn.events) s.add(e.kind)
  return s
}

// ============================================================
// Состав каталога
// ============================================================

describe('состав каталога', () => {
  it('buildCatalog возвращает непустой массив', () => {
    expect(catalog.length).toBeGreaterThan(0)
  })

  it('26 tuning + 6 holdout = 32 сценария', () => {
    const tuning = catalog.filter((s) => s.set === 'tuning')
    const holdout = catalog.filter((s) => s.set === 'holdout')
    // Цикл 2.0: +T25 (внутри-групповой раскол) +T26 (инверсия CTR/CR) под пофразный биддинг.
    expect(tuning.length).toBe(26)
    expect(holdout.length).toBe(6)
    expect(catalog.length).toBe(32)
    // Требования задания: tuning ≥ 20, holdout ≥ 5.
    expect(tuning.length).toBeGreaterThanOrEqual(20)
    expect(holdout.length).toBeGreaterThanOrEqual(5)
  })

  it('ожидаемые id присутствуют (T01–T26, H01–H06)', () => {
    const ids = new Set(catalog.map((s) => s.id))
    for (let i = 1; i <= 26; i++) expect(ids.has(`T${String(i).padStart(2, '0')}`)).toBe(true)
    for (let i = 1; i <= 6; i++) expect(ids.has(`H0${i}`)).toBe(true)
  })

  it('все id уникальны', () => {
    const ids = catalog.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ============================================================
// Инварианты каждого сценария
// ============================================================

for (const scn of catalog) {
  describe(`инварианты ${scn.id}`, () => {
    it('days в разумных пределах 10..28', () => {
      expect(scn.days).toBeGreaterThanOrEqual(10)
      expect(scn.days).toBeLessThanOrEqual(28)
    })

    it('quarantineUntilDay < days', () => {
      expect(scn.quarantineUntilDay).toBeLessThan(scn.days)
    })

    it('phrases непусты', () => {
      expect(scn.phrases.length).toBeGreaterThan(0)
    })

    it('phrase.adGroupId консистентны (все ∈ множеству групп фраз)', () => {
      const groups = new Set(scn.phrases.map((p) => p.adGroupId))
      for (const p of scn.phrases) expect(groups.has(p.adGroupId)).toBe(true)
    })

    it('QuerySpec.sticksTo ссылается на существующий keywordId', () => {
      const kwIds = new Set(scn.phrases.map((p) => p.keywordId))
      for (const q of scn.queries) {
        expect(q.sticksTo.length, `${scn.id}: пустой sticksTo у "${q.query}"`).toBeGreaterThan(0)
        for (const k of q.sticksTo) {
          expect(kwIds.has(k), `${scn.id}: "${q.query}" липнет к неизвестному keyword ${k}`).toBe(true)
        }
      }
    })

    it('сумма share прилипших запросов на фразу ≤ 0.6', () => {
      const perKeyword = new Map<number, number>()
      for (const q of scn.queries) {
        for (const k of q.sticksTo) perKeyword.set(k, (perKeyword.get(k) ?? 0) + q.share)
      }
      for (const [k, sum] of perKeyword) {
        expect(sum, `${scn.id}: keyword ${k} перегружен долей ${sum}`).toBeLessThanOrEqual(0.6)
      }
    })
  })
}

// ============================================================
// Честность expectations
// ============================================================

describe('expectations', () => {
  it('notes непусты у всех сценариев', () => {
    for (const scn of catalog) {
      expect(scn.expectations.notes.trim().length, `${scn.id}: пустые notes`).toBeGreaterThan(0)
    }
  })

  it('ровно одна «здоровая» кампания (по notes) с пустым планом', () => {
    const healthy = catalog.filter((s) => /здоров/i.test(s.expectations.notes))
    expect(healthy.map((s) => s.id)).toEqual(['T01'])
    const h = healthy[0]
    expect(Object.keys(h.expectations.causeCodes)).toHaveLength(0)
    expect(h.expectations.anomalies).toHaveLength(0)
  })

  it('у всех, КРОМЕ здоровой, непусты causeCodes ИЛИ anomalies', () => {
    for (const scn of catalog) {
      if (/здоров/i.test(scn.expectations.notes)) continue
      const hasCauses = Object.keys(scn.expectations.causeCodes).length > 0
      const hasAnomalies = scn.expectations.anomalies.length > 0
      expect(hasCauses || hasAnomalies, `${scn.id}: и causeCodes, и anomalies пусты`).toBe(true)
    }
  })

  it('ключи causeCodes валидного вида и указывают на существующий субъект', () => {
    for (const scn of catalog) {
      const kwIds = new Set(scn.phrases.map((p) => p.keywordId))
      const groups = new Set(scn.phrases.map((p) => p.adGroupId))
      const queryTexts = new Set(scn.queries.map((q) => q.query))
      for (const key of Object.keys(scn.expectations.causeCodes)) {
        if (key === 'campaign') continue
        if (key.startsWith('adgroup:')) {
          const id = key.slice('adgroup:'.length)
          expect(id.length, `${scn.id}: пустой id группы в "${key}"`).toBeGreaterThan(0)
          expect(groups.has(id), `${scn.id}: группа ${id} нет в фразах`).toBe(true)
        } else if (key.startsWith('keyword:')) {
          const rest = key.slice('keyword:'.length)
          expect(/^\d+$/.test(rest), `${scn.id}: нечисловой keyword в "${key}"`).toBe(true)
          expect(kwIds.has(Number(rest)), `${scn.id}: keyword ${rest} нет в фразах`).toBe(true)
        } else if (key.startsWith('query:')) {
          const text = key.slice('query:'.length)
          expect(text.length, `${scn.id}: пустой текст запроса в "${key}"`).toBeGreaterThan(0)
          expect(queryTexts.has(text), `${scn.id}: запрос "${text}" нет в queries`).toBe(true)
        } else {
          throw new Error(`${scn.id}: неизвестный вид ключа causeCode — "${key}"`)
        }
      }
    }
  })

  it('значения causeCodes — валидные ReasonCode из REASON_CODES', () => {
    for (const scn of catalog) {
      for (const [key, code] of Object.entries(scn.expectations.causeCodes)) {
        expect(REASON_CODE_SET.has(code), `${scn.id}: код "${code}" (${key}) вне REASON_CODES`).toBe(true)
      }
    }
  })
})

// ============================================================
// Обобщение holdout и память
// ============================================================

describe('обобщение holdout', () => {
  const tuning = catalog.filter((s) => s.set === 'tuning')
  const holdout = catalog.filter((s) => s.set === 'holdout')

  it('holdout содержит kind событий, которых НЕТ ни в одном tuning', () => {
    const tKinds = eventKinds(tuning)
    const hKinds = eventKinds(holdout)
    const onlyHoldout = [...hKinds].filter((k) => !tKinds.has(k)).sort()
    expect(onlyHoldout.length).toBeGreaterThan(0)
    // Фиксируем фактический состав «незнакомых типов».
    expect(onlyHoldout).toEqual(['competitor_brand_attack', 'fake_leads_wave'])
  })

  it('memory-сценарии (regime_change) существуют (>=1)', () => {
    const memory = catalog.filter((s) => s.events.some((e) => e.kind === 'regime_change'))
    expect(memory.length).toBeGreaterThanOrEqual(1)
    // По факту их два: T19 (G2) и H02 (G1).
    expect(memory.map((s) => s.id).sort()).toEqual(['H02', 'T19'])
  })
})

// ============================================================
// Детерминизм по baseSeed
// ============================================================

describe('детерминизм', () => {
  it('buildCatalog(1) дважды идентичен побайтно', () => {
    expect(JSON.stringify(buildCatalog(1))).toBe(JSON.stringify(buildCatalog(1)))
  })

  it('buildCatalog(1) и buildCatalog(2) различаются (сид влияет на джиттер)', () => {
    expect(JSON.stringify(buildCatalog(1))).not.toBe(JSON.stringify(buildCatalog(2)))
  })
})
