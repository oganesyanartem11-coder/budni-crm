/**
 * Тесты движка мира полигона Бориса-Директа.
 * Все прогоны детерминированы (фиксированные seed) — флейки исключены.
 */

import { describe, expect, it } from 'vitest'
import type { DayObservables, ScenarioConfig, WorldState } from '../types'
import { binomialApprox, mulberry32, poissonApprox, randInt } from './rng'
import { negativesMatch, worldEngine } from './world'

// ============================================================
// Фабрика сценариев для тестов
// ============================================================

/** Базовый сценарий: одна ядровая фраза, одна группа, одно объявление. */
function baseScenario(over: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    id: 'test-scn',
    name: 'Тестовый сценарий',
    set: 'tuning',
    days: 30,
    quarantineUntilDay: 0,
    phrases: [
      {
        keywordId: 1,
        adGroupId: 'g1',
        adGroupName: 'Обеды в офис',
        text: 'доставка обедов в офис',
        isCore: true,
        trueCtrByTv: { 15: 0.03, 65: 0.08, 75: 0.1, 85: 0.12, 100: 0.15 },
        trueCr: 0.1,
        demandPerDay: 200,
        startBidMicro: 90_000_000, // 90 ₽ → достигает TV75 (цена 80 ₽)
      },
    ],
    queries: [],
    ads: [{ adId: 101, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null }],
    events: [],
    weekdayDemand: [1, 1, 1, 1, 1, 0.1, 0.1], // б2б-обеды: выходные проседают
    conversionLagDays: { 0: 1 },
    yclidLossRate: 0,
    cpcByTv: { 15: 10, 65: 50, 75: 80, 85: 120, 100: 200 },
    expectations: { causeCodes: {}, anomalies: [], notes: '' },
    ...over,
  }
}

/** Прогнать n дней, вернуть все наблюдаемые проекции по порядку. */
function runDays(world: WorldState, n: number): DayObservables[] {
  const out: DayObservables[] = []
  for (let i = 0; i < n; i++) out.push(worldEngine.advanceDay(world))
  return out
}

/** Найти строку отчёта по дню и запросу (первая по группам). */
function findRow(obs: DayObservables, day: number, query: string) {
  return obs.queryRows.find((r) => r.day === day && r.query === query)
}

// ============================================================
// RNG: базовые свойства
// ============================================================

describe('rng', () => {
  it('mulberry32: один seed — одна последовательность, разные — разные', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const c = mulberry32(43)
    const seqA = Array.from({ length: 20 }, () => a())
    const seqB = Array.from({ length: 20 }, () => b())
    const seqC = Array.from({ length: 20 }, () => c())
    expect(seqA).toEqual(seqB)
    expect(seqA).not.toEqual(seqC)
    // Диапазон [0, 1)
    for (const x of seqA) expect(x >= 0 && x < 1).toBe(true)
  })

  it('binomialApprox: результат в [0, n], краевые p', () => {
    const rng = mulberry32(1)
    expect(binomialApprox(rng, 100, 0)).toBe(0)
    expect(binomialApprox(rng, 100, 1)).toBe(100)
    expect(binomialApprox(rng, 0, 0.5)).toBe(0)
    for (let i = 0; i < 50; i++) {
      const k = binomialApprox(rng, 200, 0.1)
      expect(k >= 0 && k <= 200).toBe(true)
    }
  })

  it('poissonApprox и randInt: без NaN и в разумных границах', () => {
    const rng = mulberry32(2)
    expect(poissonApprox(rng, 0)).toBe(0)
    expect(poissonApprox(rng, -5)).toBe(0)
    for (let i = 0; i < 30; i++) {
      expect(Number.isFinite(poissonApprox(rng, 8))).toBe(true)
      const v = randInt(rng, 2, 6)
      expect(v >= 2 && v <= 6).toBe(true)
    }
  })
})

// ============================================================
// negativesMatch: единая семантика минус-листа
// ============================================================

describe('negativesMatch', () => {
  it('двусловный минус режет только запрос со ВСЕМИ словами', () => {
    const neg = ['бесплатно москва']
    expect(negativesMatch(neg, 'доставка обедов бесплатно по москва')).toBe(true)
    expect(negativesMatch(neg, 'доставка обедов бесплатно')).toBe(false) // нет «москва»
    expect(negativesMatch(neg, 'обеды москва недорого')).toBe(false) // нет «бесплатно»
  })

  it('нормализация: регистр и ё→е; пустые списки не режут', () => {
    expect(negativesMatch(['МОСКВА'], 'обеды москва')).toBe(true)
    expect(negativesMatch(['елки'], 'купить ёлки недорого')).toBe(true)
    expect(negativesMatch([], 'любой запрос')).toBe(false)
    expect(negativesMatch([''], 'любой запрос')).toBe(false)
  })

  it('движок и экспорт указывают на одну функцию', () => {
    expect(worldEngine.negativesMatch).toBe(negativesMatch)
  })
})

// ============================================================
// Календарь и детерминизм
// ============================================================

describe('календарь мира', () => {
  it('createWorld ставит day=-1, первый advanceDay генерит day 0 (понедельник)', () => {
    const world = worldEngine.createWorld(baseScenario(), 7)
    expect(world.day).toBe(-1)
    const obs = worldEngine.advanceDay(world)
    expect(world.day).toBe(0)
    expect(obs.day).toBe(0)
    expect(obs.impressionsToday).toBeGreaterThan(0) // понедельник — полный спрос
  })

  it('сезонность: показы в субботу (day 5) сильно ниже понедельника (day 0)', () => {
    const world = worldEngine.createWorld(baseScenario(), 7)
    const days = runDays(world, 6)
    const monday = days[0].impressionsToday
    const saturday = days[5].impressionsToday
    expect(monday).toBeGreaterThan(0)
    // weekdayDemand сб = 0.1: даже с шумом ±20% суббота меньше половины понедельника
    expect(saturday).toBeLessThan(monday * 0.5)
  })
})

describe('детерминизм', () => {
  /** Богатый сценарий: события, липкие запросы, лаг, потери yclid. */
  function richScenario(): ScenarioConfig {
    return baseScenario({
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'Обеды в офис',
          text: 'доставка обедов в офис',
          isCore: true,
          trueCtrByTv: { 15: 0.03, 65: 0.08, 75: 0.1, 85: 0.12, 100: 0.15 },
          trueCr: 0.15,
          demandPerDay: 220,
          startBidMicro: 90_000_000,
        },
        {
          keywordId: 2,
          adGroupId: 'g2',
          adGroupName: 'Комплексные обеды',
          text: 'комплексные обеды с доставкой',
          isCore: false,
          trueCtrByTv: { 15: 0.02, 65: 0.06, 75: 0.08, 85: 0.1, 100: 0.12 },
          trueCr: 0.08,
          demandPerDay: 140,
          startBidMicro: 55_000_000, // 55 ₽ → TV65
        },
      ],
      queries: [
        {
          query: 'доставка обедов бесплатно за отзыв',
          sticksTo: [1],
          share: 0.2,
          trueCtr: 0.04,
          trueCr: 0,
          isTrash: true,
        },
        {
          query: 'доставка обедов в офис москва',
          sticksTo: [1],
          share: 0.25,
          trueCtr: 0.09,
          trueCr: 0.12,
          isTrash: false,
        },
      ],
      ads: [
        { adId: 101, adGroupId: 'g1', textQuality: 1, rejectedFromDay: null },
        { adId: 102, adGroupId: 'g1', textQuality: 0.8, rejectedFromDay: 3 },
        { adId: 201, adGroupId: 'g2', textQuality: 0.9, rejectedFromDay: null },
      ],
      events: [
        { kind: 'auction_drift', day: 2, priceMultiplier: 1.15 },
        { kind: 'demand_dip', day: 3, days: 2, multiplier: 0.6 },
        { kind: 'bot_wave', day: 4, days: 1, keywordIds: [1], clicksPerDay: 7 },
        { kind: 'fake_leads_wave', day: 4, days: 1, leadsPerDay: 2 },
      ],
      conversionLagDays: { 0: 0.5, 1: 0.3, 2: 0.2 },
      yclidLossRate: 0.15,
    })
  }

  /** Один и тот же сценарий + одинаковые действия по дням. */
  function playScripted(seed: number): { last: DayObservables; totals: ReturnType<typeof worldEngine.getTotals> } {
    const world = worldEngine.createWorld(richScenario(), seed)
    let last: DayObservables = worldEngine.advanceDay(world) // day 0
    worldEngine.setBid(world, 2, 85_000_000) // решение «вечером дня 0»
    last = worldEngine.advanceDay(world) // day 1
    worldEngine.setNegatives(world, ['бесплатно'])
    for (let d = 2; d <= 5; d++) last = worldEngine.advanceDay(world)
    return { last, totals: worldEngine.getTotals(world) }
  }

  it('один seed → байт-в-байт одинаковые totals и queryRows дня 5', () => {
    const runA = playScripted(1234)
    const runB = playScripted(1234)
    expect(runA.totals).toEqual(runB.totals)
    expect(JSON.stringify(runA.last.queryRows)).toBe(JSON.stringify(runB.last.queryRows))
    expect(JSON.stringify(runA.last)).toBe(JSON.stringify(runB.last)) // вся проекция дня
  })

  it('другой seed → другой мир', () => {
    const runA = playScripted(1234)
    const runC = playScripted(4321)
    expect(JSON.stringify(runA.last)).not.toBe(JSON.stringify(runC.last))
  })
})

// ============================================================
// Аукцион и ставки
// ============================================================

describe('аукцион TV', () => {
  it('ставка ниже цены TV15 → показов нет вовсе', () => {
    const scn = baseScenario()
    scn.phrases[0].startBidMicro = 5_000_000 // 5 ₽ < 10 ₽ (цена TV15)
    const world = worldEngine.createWorld(scn, 7)
    const days = runDays(world, 3)
    for (const obs of days) {
      expect(obs.impressionsToday).toBe(0)
      expect(obs.spentTodayRub).toBe(0)
    }
    expect(worldEngine.getTotals(world).spendRub).toBe(0)
  })

  it('повышение ставки до цены TV75 → показы выросли (тот же seed)', () => {
    const scnLow = baseScenario()
    scnLow.phrases[0].startBidMicro = 10_000_000 // ровно цена TV15
    const scnHigh = baseScenario()
    scnHigh.phrases[0].startBidMicro = 80_000_000 // ровно цена TV75
    const low = worldEngine.createWorld(scnLow, 99)
    const high = worldEngine.createWorld(scnHigh, 99)
    const obsLow = worldEngine.advanceDay(low)
    const obsHigh = worldEngine.advanceDay(high)
    // Шум показов — первый RNG-вызов дня, у обоих миров одинаковый:
    // охват (15/75) против (75/75) различается в 5 раз
    expect(obsHigh.impressionsToday).toBeGreaterThan(obsLow.impressionsToday * 3)
    // Аукцион отдаёт уровни с ценами: Bid уровня = цена уровня
    const auction = obsHigh.keywordBids[0].auction
    expect(auction.map((l) => l.tv)).toEqual([15, 65, 75, 85, 100])
    const tv75 = auction.find((l) => l.tv === 75)!
    expect(tv75.priceMicro).toBe(80_000_000)
    expect(tv75.bidMicro).toBe(tv75.priceMicro)
  })

  it('setBid действует со следующего дня и клампится к границам аукциона', () => {
    const scn = baseScenario()
    scn.phrases[0].startBidMicro = 5_000_000 // ниже TV15 — показов нет
    const world = worldEngine.createWorld(scn, 7)
    expect(worldEngine.advanceDay(world).impressionsToday).toBe(0) // day 0
    worldEngine.setBid(world, 1, 90_000_000)
    expect(worldEngine.advanceDay(world).impressionsToday).toBeGreaterThan(0) // day 1
    // Кламп: NaN игнорируется, отрицательное — к минимальной ставке
    worldEngine.setBid(world, 1, Number.NaN)
    expect(world.bidsMicro.get(1)).toBe(90_000_000)
    worldEngine.setBid(world, 1, -5)
    expect(world.bidsMicro.get(1)).toBe(300_000)
  })
})

// ============================================================
// Минус-лист
// ============================================================

describe('минус-лист кампании', () => {
  function scnWithTrash(): ScenarioConfig {
    return baseScenario({
      queries: [
        {
          query: 'доставка обедов бесплатно',
          sticksTo: [1],
          share: 0.4,
          trueCtr: 0, // мусор без кликов — чистое сравнение показов
          trueCr: 0,
          isTrash: true,
        },
      ],
    })
  }

  it('минус применяется со СЛЕДУЮЩЕГО дня; показы мусора пропадают, не перетекая', () => {
    const withMinus = worldEngine.createWorld(scnWithTrash(), 11)
    const noMinus = worldEngine.createWorld(scnWithTrash(), 11)

    // День 0: мусорный запрос показывается в обоих мирах
    const day0A = worldEngine.advanceDay(withMinus)
    worldEngine.advanceDay(noMinus)
    const trashRow0 = findRow(day0A, 0, 'доставка обедов бесплатно')
    expect(trashRow0).toBeDefined()
    expect(trashRow0!.impressions).toBeGreaterThan(0)

    // Решение вечером дня 0: минусуем «бесплатно»
    worldEngine.setNegatives(withMinus, ['бесплатно'])

    // День 1: у мира с минусом мусора нет, у контрольного — есть
    const day1A = worldEngine.advanceDay(withMinus)
    const day1B = worldEngine.advanceDay(noMinus)
    expect(findRow(day1A, 1, 'доставка обедов бесплатно')).toBeUndefined()
    expect(findRow(day1B, 1, 'доставка обедов бесплатно')).toBeDefined()

    // История дня 0 не переписывается (строка мусора за day 0 осталась)
    expect(findRow(day1A, 0, 'доставка обедов бесплатно')).toBeDefined()

    // Показы НЕ перетекают: собственный запрос фразы в день 1 одинаков в обоих мирах
    const ownA = findRow(day1A, 1, 'доставка обедов в офис')!
    const ownB = findRow(day1B, 1, 'доставка обедов в офис')!
    expect(ownA.impressions).toBe(ownB.impressions)
  })
})

// ============================================================
// Лаг конверсии и честность отчётов
// ============================================================

describe('лаг конверсии', () => {
  it('заявка с лагом 2: не видна в отчёте дня клика, снятом в day+1, видна в day+2', () => {
    const scn = baseScenario({
      conversionLagDays: { 2: 1 }, // лаг ВСЕГДА 2 дня
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'Обеды в офис',
          text: 'доставка обедов в офис',
          isCore: true,
          trueCtrByTv: { 15: 1, 65: 1, 75: 1, 85: 1, 100: 1 }, // клик с каждого показа
          trueCr: 1, // заявка с каждого клика
          demandPerDay: 20,
          startBidMicro: 90_000_000,
        },
      ],
    })
    const world = worldEngine.createWorld(scn, 5)

    const obs0 = worldEngine.advanceDay(world) // day 0: клики и «будущие» заявки
    const row0 = findRow(obs0, 0, 'доставка обедов в офис')!
    expect(row0.clicks).toBeGreaterThan(0)
    expect(row0.conversions).toBe(0) // leadDay = 2 ещё не наступил

    const obs1 = worldEngine.advanceDay(world) // day 1: отчёт «за вчера», снятый сегодня
    expect(findRow(obs1, 0, 'доставка обедов в офис')!.conversions).toBe(0)
    expect(obs1.newLeads.length).toBe(0)

    const obs2 = worldEngine.advanceDay(world) // day 2: заявки материализовались
    const row0at2 = findRow(obs2, 0, 'доставка обедов в офис')!
    expect(row0at2.conversions).toBe(row0.clicks) // конверсии дописались в ДЕНЬ КЛИКА
    // Новые заявки дня 2 — это заявки кликов дня 0
    expect(obs2.newLeads.length).toBe(row0.clicks)
    // Метрика считает достижения цели по дню МАТЕРИАЛИЗАЦИИ
    expect(obs2.metrika.goalReaches).toBe(row0.clicks)
    expect(obs0.metrika.goalReaches).toBe(0)
  })
})

// ============================================================
// События мира
// ============================================================

describe('события мира', () => {
  it('form_break: визиты и reachedForm живут, заявки в ноль', () => {
    const scn = baseScenario({
      events: [{ kind: 'form_break', day: 0 }],
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'Обеды в офис',
          text: 'доставка обедов в офис',
          isCore: true,
          trueCtrByTv: { 15: 0.5, 65: 0.5, 75: 0.5, 85: 0.5, 100: 0.5 },
          trueCr: 1, // без поломки заявки были бы с каждого клика
          demandPerDay: 60,
          startBidMicro: 90_000_000,
        },
      ],
    })
    const world = worldEngine.createWorld(scn, 3)
    const days = runDays(world, 3)
    let visits = 0
    let maxFormReach = 0
    for (const obs of days) {
      visits += obs.metrika.visits
      maxFormReach = Math.max(maxFormReach, obs.metrika.formReachRate)
      expect(obs.newLeads.length).toBe(0)
    }
    expect(visits).toBeGreaterThan(0) // трафик идёт
    expect(maxFormReach).toBeGreaterThan(0) // до формы доходят (форма видна, но сломана)
    expect(worldEngine.getTotals(world).trueLeads).toBe(0) // заявок нет
  })

  it('bot_wave: клики и расход есть, визитов нет', () => {
    const scn = baseScenario({
      events: [{ kind: 'bot_wave', day: 0, days: 1, keywordIds: [1], clicksPerDay: 5 }],
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'Обеды в офис',
          text: 'доставка обедов в офис',
          isCore: true,
          trueCtrByTv: { 15: 0, 65: 0, 75: 0, 85: 0, 100: 0 }, // органических кликов нет
          trueCr: 1,
          demandPerDay: 50,
          startBidMicro: 90_000_000,
        },
      ],
    })
    const world = worldEngine.createWorld(scn, 7)
    const obs = worldEngine.advanceDay(world)
    const row = findRow(obs, 0, 'доставка обедов в офис')!
    expect(row.clicks).toBe(5) // все клики — ботовые
    expect(row.conversions).toBe(0)
    expect(obs.spentTodayRub).toBeGreaterThan(0) // деньги сгорели
    expect(obs.metrika.visits).toBe(0) // Метрика пуста — главный маркер BOT_TRAFFIC
    expect(worldEngine.getTotals(world).trueLeads).toBe(0)
  })

  it('regime_change: множитель CR меняет частоту заявок с дня события', () => {
    const mk = (events: ScenarioConfig['events']) =>
      baseScenario({
        events,
        conversionLagDays: { 0: 1 },
        phrases: [
          {
            keywordId: 1,
            adGroupId: 'g1',
            adGroupName: 'Обеды в офис',
            text: 'доставка обедов в офис',
            isCore: true,
            trueCtrByTv: { 15: 0.3, 65: 0.3, 75: 0.3, 85: 0.3, 100: 0.3 },
            trueCr: 0.5,
            demandPerDay: 80,
            startBidMicro: 90_000_000,
          },
        ],
      })
    const normal = worldEngine.createWorld(mk([]), 21)
    const collapsed = worldEngine.createWorld(
      mk([{ kind: 'regime_change', day: 0, adGroupId: 'g1', newCrMultiplier: 0 }]),
      21
    )
    runDays(normal, 4)
    runDays(collapsed, 4)
    expect(worldEngine.getTotals(normal).trueLeads).toBeGreaterThan(0)
    expect(worldEngine.getTotals(collapsed).trueLeads).toBe(0) // экономика группы умерла
  })

  it('fake_leads_wave: пустышки с телефонами-дублями и без yclid/utm', () => {
    const scn = baseScenario({
      events: [{ kind: 'fake_leads_wave', day: 0, days: 2, leadsPerDay: 3 }],
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'Обеды в офис',
          text: 'доставка обедов в офис',
          isCore: true,
          trueCtrByTv: { 15: 0, 65: 0, 75: 0, 85: 0, 100: 0 }, // настоящих заявок нет
          trueCr: 0,
          demandPerDay: 50,
          startBidMicro: 90_000_000,
        },
      ],
    })
    const world = worldEngine.createWorld(scn, 13)
    const [obs0, obs1] = runDays(world, 2)
    expect(obs0.newLeads.length).toBe(3)
    expect(obs1.newLeads.length).toBe(3)
    const allLeads = [...obs0.newLeads, ...obs1.newLeads]
    const phones = new Set(allLeads.map((l) => l.phoneDigits))
    expect(phones.size).toBe(1) // один и тот же номер — ДУБЛИ
    for (const lead of allLeads) {
      expect(lead.yclid).toBeNull()
      expect(lead.utmTerm).toBeNull()
      expect(lead.phoneDigits).toMatch(/^79\d{9}$/)
    }
    // Правда мира: наблюдаемых заявок 6, настоящих — 0
    const totals = worldEngine.getTotals(world)
    expect(totals.observedLeads).toBe(6)
    expect(totals.trueLeads).toBe(0)
  })

  it('metrica_tag_off: новые заявки теряют yclid и utm с дня события', () => {
    const scn = baseScenario({
      events: [{ kind: 'metrica_tag_off', day: 1 }],
      conversionLagDays: { 0: 1 },
      yclidLossRate: 0,
      phrases: [
        {
          keywordId: 1,
          adGroupId: 'g1',
          adGroupName: 'Обеды в офис',
          text: 'доставка обедов в офис',
          isCore: true,
          trueCtrByTv: { 15: 1, 65: 1, 75: 1, 85: 1, 100: 1 },
          trueCr: 1,
          demandPerDay: 15,
          startBidMicro: 90_000_000,
        },
      ],
    })
    const world = worldEngine.createWorld(scn, 17)
    const obs0 = worldEngine.advanceDay(world)
    expect(obs0.addMetricaTag).toBe('YES')
    expect(obs0.newLeads.length).toBeGreaterThan(0)
    for (const lead of obs0.newLeads) {
      expect(lead.yclid).not.toBeNull() // разметка жива, потерь нет (rate 0)
      expect(lead.utmTerm).toBe('доставка обедов в офис')
    }
    const obs1 = worldEngine.advanceDay(world) // разметка слетела
    expect(obs1.addMetricaTag).toBe('NO')
    expect(obs1.newLeads.length).toBeGreaterThan(0)
    for (const lead of obs1.newLeads) {
      expect(lead.yclid).toBeNull()
      expect(lead.utmTerm).toBeNull()
      expect(lead.utmCampaign).toBeNull()
    }
    // setMetricaTag('YES') чинит разметку со следующего дня
    worldEngine.setMetricaTag(world, 'YES')
    const obs2 = worldEngine.advanceDay(world)
    expect(obs2.addMetricaTag).toBe('YES')
    for (const lead of obs2.newLeads) expect(lead.yclid).not.toBeNull()
  })
})

// ============================================================
// Остановки
// ============================================================

describe('остановки', () => {
  it('suspendCampaign и suspendKeywords гасят показы со следующего дня', () => {
    const world = worldEngine.createWorld(baseScenario(), 7)
    expect(worldEngine.advanceDay(world).impressionsToday).toBeGreaterThan(0)
    worldEngine.suspendKeywords(world, [1])
    expect(worldEngine.advanceDay(world).impressionsToday).toBe(0)

    const world2 = worldEngine.createWorld(baseScenario(), 7)
    expect(worldEngine.advanceDay(world2).impressionsToday).toBeGreaterThan(0)
    worldEngine.suspendCampaign(world2)
    const obs = worldEngine.advanceDay(world2)
    expect(obs.impressionsToday).toBe(0)
    expect(obs.spentTodayRub).toBe(0)
  })
})
