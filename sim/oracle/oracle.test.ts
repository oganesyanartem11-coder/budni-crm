/**
 * Тесты зоны sim/oracle/: оракул, эталоны атрибуции, боты-эталоны,
 * консервативная диагностика. Все прогоны детерминированы (фиксированные
 * seed), без сети/БД. Для реалистичных миров берём движок и каталог.
 */

import { describe, it, expect } from 'vitest'
import { worldEngine } from '../engine/world'
import { mulberry32 } from '../engine/rng'
import { buildCatalog } from '../scenarios/catalog'
import { leadKey } from '../types'
import type { CapturedAction, DayObservables, ScenarioConfig } from '../types'
import { computeOracleVerdicts, computeAttributionReferences } from './oracle'
import { makeLazyBot, makeRandomBot, makeGreedyBot, makeOracleBot, type BotPolicy } from './baselines'
import { inferCauseCodes } from './best-inferable'

// ============================================================
// Помощники сборки контролируемых сценариев
// ============================================================

/** Базовая цена уровней (как в калибровке каталога). */
const CPC: Record<number, number> = { 15: 25, 65: 45, 75: 60, 85: 190, 100: 260 }
/** Ровная недельная сезонность — упрощает ручной расчёт ожиданий. */
const FLAT_WEEK = [1, 1, 1, 1, 1, 1, 1] as ScenarioConfig['weekdayDemand']

function scn(over: Partial<ScenarioConfig>): ScenarioConfig {
  return {
    id: 'CTRL',
    name: 'controlled',
    set: 'tuning',
    days: 18,
    quarantineUntilDay: 0,
    phrases: [],
    queries: [],
    ads: [],
    events: [],
    weekdayDemand: FLAT_WEEK,
    conversionLagDays: { 0: 1 },
    yclidLossRate: 0,
    cpcByTv: { ...CPC },
    expectations: { causeCodes: {}, anomalies: [], notes: '' },
    ...over,
  }
}

/** Прогнать бота на мире (создаём мир, крутим все дни), вернуть мир и captured. */
function runBot(config: ScenarioConfig, seed: number, bot: BotPolicy): { world: ReturnType<typeof worldEngine.createWorld>; captured: CapturedAction[] } {
  const world = worldEngine.createWorld(config, seed)
  const captured: CapturedAction[] = []
  for (let d = 0; d < config.days; d++) {
    const obs = worldEngine.advanceDay(world)
    bot.onDayEnd(world, worldEngine, obs, captured)
  }
  return { world, captured }
}

/** Собрать наблюдаемое по всем дням (для inferCauseCodes). */
function collectDays(config: ScenarioConfig, seed: number): DayObservables[] {
  const world = worldEngine.createWorld(config, seed)
  const days: DayObservables[] = []
  for (let d = 0; d < config.days; d++) days.push(worldEngine.advanceDay(world))
  return days
}

// ============================================================
// mustMinus / mustKeep
// ============================================================

describe('computeOracleVerdicts: mustMinus / mustKeep', () => {
  it('mustMinus берёт объёмный мусор и отбрасывает мелочь (<100 ₽)', () => {
    const config = scn({
      days: 18,
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'G1',
          text: 'доставка обедов в офис',
          isCore: true,
          trueCtrByTv: { 15: 0.02, 65: 0.05, 75: 0.07, 85: 0.09, 100: 0.11 },
          trueCr: 0.05,
          demandPerDay: 200,
          startBidMicro: 52_000_000, // 52 ₽ → уровень 65 (цена 45 ₽)
        },
      ],
      queries: [
        // Объёмный мусор: ~117 ₽/день × 18 ≈ 2100 ₽ ≥ 100 → mustMinus.
        { query: 'доставка обедов бесплатно', sticksTo: [1], share: 0.3, trueCtr: 0.05, trueCr: 0, isTrash: true },
        // Мелочь: ~0.2 ₽/день × 18 ≈ 3.5 ₽ < 100 → НЕ в mustMinus.
        { query: 'обеды казань', sticksTo: [1], share: 0.005, trueCtr: 0.005, trueCr: 0, isTrash: true },
      ],
      ads: [{ adId: 1, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null }],
    })
    const v = computeOracleVerdicts(config)
    expect(v.mustMinus.has('доставка обедов бесплатно')).toBe(true)
    expect(v.mustMinus.has('обеды казань')).toBe(false)
    // mustKeep содержит текст конвертящей фразы и не пересекается с mustMinus.
    expect(v.mustKeep.has('доставка обедов в офис')).toBe(true)
    for (const q of v.mustMinus) expect(v.mustKeep.has(q)).toBe(false)
  })

  it('mustMinus ⊆ trash, mustKeep — только цели с trueCr>0', () => {
    const config = scn({
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'G1',
          text: 'обеды в офис',
          isCore: true,
          trueCtrByTv: { 15: 0.02, 65: 0.05, 75: 0.07, 85: 0.09, 100: 0.11 },
          trueCr: 0.05,
          demandPerDay: 150,
          startBidMicro: 52_000_000,
        },
      ],
      queries: [
        { query: 'обеды в офис москва', sticksTo: [1], share: 0.2, trueCtr: 0.06, trueCr: 0.05, isTrash: false }, // живой
        { query: 'обеды в офис бесплатно', sticksTo: [1], share: 0.25, trueCtr: 0.04, trueCr: 0, isTrash: true }, // мусор
      ],
      ads: [{ adId: 1, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null }],
    })
    const v = computeOracleVerdicts(config)
    expect(v.mustKeep.has('обеды в офис москва')).toBe(true) // живой запрос
    expect(v.mustMinus.has('обеды в офис москва')).toBe(false)
    for (const q of v.mustMinus) {
      const spec = config.queries.find((x) => x.query === q)
      expect(spec?.isTrash).toBe(true)
    }
  })
})

// ============================================================
// optimalTv
// ============================================================

describe('computeOracleVerdicts: optimalTv', () => {
  it('лид-негативная фраза → 15; уровни только {15,65,75}; никогда премиум', () => {
    const config = scn({
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'G1',
          text: 'конвертит',
          isCore: true,
          trueCtrByTv: { 15: 0.02, 65: 0.05, 75: 0.07, 85: 0.09, 100: 0.11 },
          trueCr: 0.05,
          demandPerDay: 200,
          startBidMicro: 52_000_000,
        },
        {
          keywordId: 2,
          adGroupId: 'g1',
          adGroupName: 'G1',
          text: 'не конвертит',
          isCore: false,
          trueCtrByTv: { 15: 0.02, 65: 0.05, 75: 0.07, 85: 0.09, 100: 0.11 },
          trueCr: 0, // лид-негативная
          demandPerDay: 200,
          startBidMicro: 52_000_000,
        },
      ],
      ads: [{ adId: 1, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null }],
    })
    const v = computeOracleVerdicts(config)
    expect(v.optimalTv.get(2)).toBe(15) // лид-негативная
    for (const tv of v.optimalTv.values()) {
      expect([15, 65, 75, null]).toContain(tv)
      expect(tv === 85 || tv === 100).toBe(false)
    }
    // Конвертящая ядровая — лид-позитивная, уровень нижнего блока.
    expect([15, 65, 75]).toContain(v.optimalTv.get(1))
  })

  it('потолок 400 ₽: дорогой уровень исключается, всё дороже → null + AUCTION_ABOVE_CEILING', () => {
    // Все уровни дороже 400 ₽ → optimalTv null и код по потолку.
    const allTooPricey = scn({
      cpcByTv: { 15: 450, 65: 500, 75: 600, 85: 700, 100: 800 },
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'G1',
          text: 'дорогая',
          isCore: true,
          trueCtrByTv: { 15: 0.05, 65: 0.07, 75: 0.09, 85: 0.1, 100: 0.12 },
          trueCr: 0.06,
          demandPerDay: 200,
          startBidMicro: 500_000_000,
        },
      ],
      ads: [{ adId: 1, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null }],
    })
    const v1 = computeOracleVerdicts(allTooPricey)
    expect(v1.optimalTv.get(1)).toBeNull()
    expect(v1.causeCodes['keyword:1']).toBe('AUCTION_ABOVE_CEILING')

    // Только 75 дороже потолка → выбор из {15,65}, никогда 75.
    const tv75TooPricey = scn({
      cpcByTv: { 15: 25, 65: 45, 75: 600, 85: 700, 100: 800 },
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'G1',
          text: 'конвертит',
          isCore: true,
          trueCtrByTv: { 15: 0.02, 65: 0.05, 75: 0.07, 85: 0.09, 100: 0.11 },
          trueCr: 0.05,
          demandPerDay: 200,
          startBidMicro: 52_000_000,
        },
      ],
      ads: [{ adId: 1, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null }],
    })
    const v2 = computeOracleVerdicts(tv75TooPricey)
    expect([15, 65]).toContain(v2.optimalTv.get(1))
    expect(v2.optimalTv.get(1)).not.toBe(75)
  })

  it('phase post после regime_change (cr ×0.15) даёт уровень ≤ pre', () => {
    const config = scn({
      days: 14,
      phrases: [
        {
          keywordId: 10,
          adGroupId: 'g2',
          adGroupName: 'G2',
          text: 'обеды на стройку',
          isCore: true,
          trueCtrByTv: { 15: 0.02, 65: 0.05, 75: 0.07, 85: 0.09, 100: 0.11 },
          trueCr: 0.03,
          demandPerDay: 40,
          startBidMicro: 60_000_000,
        },
      ],
      ads: [{ adId: 1, adGroupId: 'g2', textQuality: 1, rejectedFromDay: null }],
      events: [{ kind: 'regime_change', day: 5, adGroupId: 'g2', newCrMultiplier: 0.15 }],
    })
    const pre = computeOracleVerdicts(config, { phase: 'pre' }).optimalTv.get(10)
    const post = computeOracleVerdicts(config, { phase: 'post' }).optimalTv.get(10)
    // Оба — уровни; после обвала CR оракул уходит НЕ выше.
    const rank = (tv: number | null | undefined): number => (tv == null ? -1 : tv)
    expect(rank(post)).toBeLessThanOrEqual(rank(pre))
  })

  it('весь каталог × все фазы: инварианты optimalTv и mustKeep∩mustMinus=∅', () => {
    const catalog = buildCatalog(1)
    for (const config of catalog) {
      for (const phase of ['pre', 'post', 'blend'] as const) {
        const v = computeOracleVerdicts(config, { phase })
        for (const tv of v.optimalTv.values()) {
          expect([15, 65, 75, null]).toContain(tv)
          expect(tv === 85 || tv === 100).toBe(false)
          if (tv !== null) expect(config.cpcByTv[tv]).toBeLessThanOrEqual(400)
        }
        for (const q of v.mustMinus) expect(v.mustKeep.has(q)).toBe(false)
        // причины из expectations сохранены.
        for (const [k, code] of Object.entries(config.expectations.causeCodes)) {
          expect(v.causeCodes[k]).toBe(code)
        }
      }
    }
  })
})

// ============================================================
// computeAttributionReferences
// ============================================================

describe('computeAttributionReferences', () => {
  it('настоящая заявка в omniscient; пустышка нигде; потерянный yclid — в omniscient, не в inferable', () => {
    const config = scn({
      days: 5,
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'G1',
          text: 'фраза',
          isCore: true,
          trueCtrByTv: { 15: 0.5, 65: 0.5, 75: 0.5, 85: 0.5, 100: 0.5 },
          trueCr: 0.5,
          demandPerDay: 200,
          startBidMicro: 90_000_000, // → уровень 75
        },
      ],
      ads: [{ adId: 1, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null }],
      events: [{ kind: 'fake_leads_wave', day: 1, days: 1, leadsPerDay: 3 }],
      conversionLagDays: { 0: 1 },
      yclidLossRate: 0.5, // ~половина настоящих заявок теряет yclid
      cpcByTv: { 15: 10, 65: 50, 75: 80, 85: 120, 100: 200 },
    })
    const world = worldEngine.createWorld(config, 4242)
    for (let d = 0; d < config.days; d++) worldEngine.advanceDay(world)

    const internal = world.internal as { phoneByClick: Map<number, string> }
    // Отобрать образцы каждого рода из правды мира.
    let realWithYclidKey: string | null = null
    let realNoYclidKey: string | null = null
    let fakeKey: string | null = null
    world.truthClicks.forEach((c, i) => {
      if (c.leadDay === null) return
      const phone = internal.phoneByClick.get(i)
      if (phone === undefined) return
      const key = leadKey(phone, c.leadDay)
      if (c.leadIsFake) fakeKey = key
      else if (c.yclid !== null) realWithYclidKey = realWithYclidKey ?? key
      else realNoYclidKey = realNoYclidKey ?? key
    })
    expect(realWithYclidKey).not.toBeNull()
    expect(realNoYclidKey).not.toBeNull()
    expect(fakeKey).not.toBeNull()

    const refs = computeAttributionReferences(world)
    // Настоящая с yclid — в обоих эталонах.
    expect(refs.omniscient.has(realWithYclidKey!)).toBe(true)
    expect(refs.inferable.has(realWithYclidKey!)).toBe(true)
    expect(refs.omniscient.get(realWithYclidKey!)?.adGroupId).toBe('g1')
    // Настоящая без yclid — всезнающий знает, наблюдаемое НЕТ.
    expect(refs.omniscient.has(realNoYclidKey!)).toBe(true)
    expect(refs.inferable.has(realNoYclidKey!)).toBe(false)
    // Пустышка — нигде.
    expect(refs.omniscient.has(fakeKey!)).toBe(false)
    expect(refs.inferable.has(fakeKey!)).toBe(false)
    // Зазор всезнание−наблюдаемое существует (часть yclid потеряна).
    expect(refs.omniscient.size).toBeGreaterThan(refs.inferable.size)
  })
})

// ============================================================
// Боты-эталоны
// ============================================================

describe('boty-эталоны', () => {
  it('makeLazyBot ничего не пишет в captured', () => {
    const config = scn({
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'G1',
          text: 'фраза',
          isCore: true,
          trueCtrByTv: { 15: 0.02, 65: 0.05, 75: 0.07, 85: 0.09, 100: 0.11 },
          trueCr: 0.05,
          demandPerDay: 120,
          startBidMicro: 52_000_000,
        },
      ],
      ads: [{ adId: 1, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null }],
    })
    const { captured } = runBot(config, 7, makeLazyBot())
    expect(captured.length).toBe(0)
  })

  it('makeRandomBot детерминирован от одного rng (два прогона байт-в-байт)', () => {
    const config = scn({
      days: 20,
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'G1',
          text: 'фраза один',
          isCore: true,
          trueCtrByTv: { 15: 0.02, 65: 0.05, 75: 0.07, 85: 0.09, 100: 0.11 },
          trueCr: 0.05,
          demandPerDay: 150,
          startBidMicro: 52_000_000,
        },
        {
          keywordId: 2,
          adGroupId: 'g2',
          adGroupName: 'G2',
          text: 'фраза два',
          isCore: false,
          trueCtrByTv: { 15: 0.02, 65: 0.05, 75: 0.07, 85: 0.09, 100: 0.11 },
          trueCr: 0.04,
          demandPerDay: 120,
          startBidMicro: 52_000_000,
        },
      ],
      ads: [
        { adId: 1, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null },
        { adId: 2, adGroupId: 'g2', textQuality: 1, rejectedFromDay: null },
      ],
    })
    const a = runBot(config, 11, makeRandomBot(mulberry32(123)))
    const b = runBot(config, 11, makeRandomBot(mulberry32(123)))
    expect(a.captured.length).toBeGreaterThan(0) // рандом действительно шевелится
    expect(JSON.stringify(a.captured)).toBe(JSON.stringify(b.captured))
  })

  it('makeGreedyBot режет живой запрос с кликами и без конверсий (факт жадности)', () => {
    const config = scn({
      days: 5,
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'G1',
          text: 'фраза',
          isCore: true,
          trueCtrByTv: { 15: 0.5, 65: 0.5, 75: 0.5, 85: 0.5, 100: 0.5 },
          trueCr: 0.06,
          demandPerDay: 200,
          startBidMicro: 90_000_000, // → уровень 75
        },
      ],
      queries: [
        // Живой конвертор, но конверсии дозревают только на 5-й день (лаг) —
        // в первые дни выглядит как «клики есть, заявок нет».
        { query: 'живой запрос на работу', sticksTo: [1], share: 0.3, trueCtr: 0.4, trueCr: 0.06, isTrash: false },
      ],
      ads: [{ adId: 1, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null }],
      conversionLagDays: { 5: 1 }, // все конверсии с лагом 5 дней
      cpcByTv: { 15: 10, 65: 50, 75: 80, 85: 120, 100: 200 },
    })
    // Жадный запрос — живой (mustKeep), но жадный бот его порежет.
    const v = computeOracleVerdicts(config)
    expect(v.mustKeep.has('живой запрос на работу')).toBe(true)

    const { world, captured } = runBot(config, 7, makeGreedyBot())
    expect(world.negatives).toContain('живой запрос на работу')
    expect(captured.some((a) => a.type === 'negatives_set' && a.by === 'greedy')).toBe(true)
  })

  it('makeOracleBot в день 1 пишет captured (ставки + минус)', () => {
    const config = scn({
      days: 6,
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'G1',
          text: 'конвертор',
          isCore: true,
          trueCtrByTv: { 15: 0.02, 65: 0.05, 75: 0.07, 85: 0.09, 100: 0.11 },
          trueCr: 0.05,
          demandPerDay: 200,
          startBidMicro: 52_000_000,
        },
      ],
      queries: [
        { query: 'обеды бесплатно', sticksTo: [1], share: 0.3, trueCtr: 0.05, trueCr: 0, isTrash: true },
      ],
      ads: [{ adId: 1, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null }],
    })
    const verdictsPre = computeOracleVerdicts(config)
    // Предусловия: есть что ставить и что минусовать.
    expect(verdictsPre.optimalTv.get(1)).not.toBeNull()
    expect(verdictsPre.mustMinus.size).toBeGreaterThan(0)

    const { captured } = runBot(config, 7, makeOracleBot(verdictsPre, null, null))
    const day1 = captured.filter((a) => a.day === 1)
    expect(day1.some((a) => a.type === 'bid_set')).toBe(true)
    expect(day1.some((a) => a.type === 'negatives_set')).toBe(true)
  })
})

// ============================================================
// best-inferable (консервативная диагностика)
// ============================================================

describe('inferCauseCodes', () => {
  it('распознаёт BOT_TRAFFIC: клики есть, визитов Метрики нет', () => {
    const config = scn({
      days: 5,
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'G1',
          text: 'ботовая фраза',
          isCore: true,
          trueCtrByTv: { 15: 0, 65: 0, 75: 0, 85: 0, 100: 0 }, // органических кликов нет
          trueCr: 0,
          demandPerDay: 50,
          startBidMicro: 90_000_000,
        },
      ],
      ads: [{ adId: 1, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null }],
      events: [{ kind: 'bot_wave', day: 0, days: 3, keywordIds: [1], clicksPerDay: 15 }],
      cpcByTv: { 15: 10, 65: 50, 75: 80, 85: 120, 100: 200 },
    })
    const days = collectDays(config, 7)
    const codes = inferCauseCodes(days, config)
    expect(codes['keyword:1']).toBe('BOT_TRAFFIC')
  })

  it('на здоровой кампании молчит (пустой либо без ложных кодов)', () => {
    const config = scn({
      days: 10,
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'G1',
          text: 'здоровая фраза',
          isCore: true,
          trueCtrByTv: { 15: 0.02, 65: 0.05, 75: 0.07, 85: 0.09, 100: 0.11 },
          trueCr: 0.06,
          demandPerDay: 200,
          startBidMicro: 90_000_000,
        },
      ],
      ads: [{ adId: 1, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null }],
      cpcByTv: { 15: 10, 65: 50, 75: 80, 85: 120, 100: 200 },
    })
    const days = collectDays(config, 7)
    const codes = inferCauseCodes(days, config)
    expect(codes['keyword:1']).toBeUndefined()
    expect(codes['campaign']).toBeUndefined()
  })
})
