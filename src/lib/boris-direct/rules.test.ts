import { describe, it, expect } from 'vitest'

/**
 * Чистые правила мозга: карантин, минусовка, бинарная шкала ставок,
 * circuit breaker. Без сети/БД/LLM — проверяем арифметику напрямую.
 */

import {
  isInQuarantine,
  campaignAgeDays,
  decideQuarantine,
  normalizeWord,
  validateMinusPhrase,
  intersectsCore,
  prepareMinusCandidates,
  pickDataDrivenMinusCandidates,
  recommendBid,
  checkCircuitBreaker,
  isSuspiciousNegativesShrink,
  pickBehavioralMinusCandidates,
} from './rules'
import {
  QUARANTINE_DAYS,
  QUARANTINE_MIN_CLICKS,
  MINUS_MIN_IMPRESSIONS,
  MINUS_WORD_MAX_LEN,
  BID_CEILING_MICRO,
  MICRO,
  CB_MAX_BID_CHANGES_PER_TICK,
} from './config'
import type { QueryStatRow } from './attribution'

function makeRow(overrides: Partial<QueryStatRow> = {}): QueryStatRow {
  return {
    query: 'доставка обедов в офис',
    adGroupName: 'G1',
    adGroupId: '1',
    criterionId: null,
    impressions: 100,
    clicks: 5,
    costRub: 500,
    conversions: 0,
    ...overrides,
  }
}

describe('isInQuarantine', () => {
  it('мало дней данных → карантин, даже при кликах', () => {
    expect(isInQuarantine({ daysOfData: QUARANTINE_DAYS - 1, totalClicks: 1000 })).toBe(true)
  })

  it('мало кликов → карантин, даже при днях', () => {
    expect(isInQuarantine({ daysOfData: QUARANTINE_DAYS + 5, totalClicks: QUARANTINE_MIN_CLICKS - 1 })).toBe(true)
  })

  it('дней и кликов достаточно → не карантин', () => {
    expect(isInQuarantine({ daysOfData: QUARANTINE_DAYS, totalClicks: QUARANTINE_MIN_CLICKS })).toBe(false)
  })
})

describe('campaignAgeDays', () => {
  it('StartDate 2026-06-30, сегодня 2026-07-07 → 7 (exclusive)', () => {
    expect(campaignAgeDays('2026-06-30', '2026-07-07')).toBe(7)
  })

  it('старт = сегодня → 0', () => {
    expect(campaignAgeDays('2026-07-07', '2026-07-07')).toBe(0)
  })
})

describe('decideQuarantine (реальные входы гейта)', () => {
  it('StartDate 30.06, сегодня 07.07 (7 дней), кумулятив 37 → НЕ карантин', () => {
    const r = decideQuarantine({ startDate: '2026-06-30', todayMsk: '2026-07-07', cumulativeClicks: 37 })
    expect(r.quarantine).toBe(false)
    expect(r.factors).toMatchObject({ daysOfData: 7, totalClicks: 37 })
  })

  it('StartDate сегодня−2 (2<5 дней), кумулятив 50 → карантин (ветка дней)', () => {
    const r = decideQuarantine({ startDate: '2026-07-05', todayMsk: '2026-07-07', cumulativeClicks: 50 })
    expect(r.quarantine).toBe(true)
    expect(r.factors).toMatchObject({ daysOfData: 2, totalClicks: 50 })
  })

  it('StartDate сегодня−6 (6≥5 дней), кумулятив 20<30 → карантин (ветка кликов)', () => {
    const r = decideQuarantine({ startDate: '2026-07-01', todayMsk: '2026-07-07', cumulativeClicks: 20 })
    expect(r.quarantine).toBe(true)
    expect(r.factors).toMatchObject({ daysOfData: 6, totalClicks: 20 })
  })

  it('нет StartDate → карантин (fail-safe)', () => {
    const r = decideQuarantine({ startDate: null, todayMsk: '2026-07-07', cumulativeClicks: 100 })
    expect(r.quarantine).toBe(true)
  })

  it('кумулятив недоступен (null) → карантин (fail-safe)', () => {
    const r = decideQuarantine({ startDate: '2026-06-30', todayMsk: '2026-07-07', cumulativeClicks: null })
    expect(r.quarantine).toBe(true)
  })
})

describe('normalizeWord', () => {
  it('lower, ё→е, trim', () => {
    expect(normalizeWord('  Ёлка ')).toBe('елка')
    expect(normalizeWord('ОБЕДЫ')).toBe('обеды')
  })
})

describe('validateMinusPhrase — механика Директа', () => {
  it('обычная фраза проходит', () => {
    expect(validateMinusPhrase('вакансии повара')).toEqual({ ok: true })
  })

  it('цифры → отказ', () => {
    const res = validateMinusPhrase('обеды за 100 рублей')
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('цифры')
  })

  it.each(['/', '\\', '«', '»', '"'])('символ %s → отказ', (char) => {
    expect(validateMinusPhrase(`обеды ${char}дёшево`).ok).toBe(false)
  })

  it(`слово длиннее ${MINUS_WORD_MAX_LEN} символов → отказ`, () => {
    const longWord = 'а'.repeat(MINUS_WORD_MAX_LEN + 1)
    const res = validateMinusPhrase(`обеды ${longWord}`)
    expect(res.ok).toBe(false)
    expect(res.reason).toContain(String(MINUS_WORD_MAX_LEN))
  })

  it('пустая фраза → отказ', () => {
    expect(validateMinusPhrase('   ').ok).toBe(false)
  })
})

describe('intersectsCore — узкий токен', () => {
  const core = ['доставка обедов в офис', 'корпоративное питание москва']

  it('однословная минус-фраза: слово есть в ключевой фразе → пересечение', () => {
    expect(intersectsCore('обедов', core)).toBe(true)
  })

  it('однословная: слова нет нигде → нет пересечения', () => {
    expect(intersectsCore('вакансии', core)).toBe(false)
  })

  it('двусловная: ОБА слова в ОДНОЙ ключевой фразе → пересечение', () => {
    expect(intersectsCore('доставка офис', core)).toBe(true)
  })

  it('двусловная: слова в РАЗНЫХ ключевых фразах → нет пересечения', () => {
    // «доставка» в первой фразе, «москва» во второй — вместе нигде.
    expect(intersectsCore('доставка москва', core)).toBe(false)
  })

  it('нормализация: ё/е и регистр не мешают', () => {
    expect(intersectsCore('ОБЕДОВ', core)).toBe(true)
  })
})

describe('prepareMinusCandidates — конвейер', () => {
  const core = ['доставка обедов в офис']

  it('механика → ядро → дедуп: смесь кандидатов раскладывается по корзинам', () => {
    const res = prepareMinusCandidates(
      ['вакансии повара', 'обеды 24', 'доставка офис', 'Вакансии Повара', 'своими руками'],
      { coreKeywords: core, existingMinus: [] }
    )
    expect(res.accepted).toEqual(['вакансии повара', 'своими руками'])
    expect(res.rejected).toEqual([
      { phrase: 'обеды 24', reason: expect.stringContaining('цифры') },
      { phrase: 'доставка офис', reason: expect.stringContaining('ядром') },
      { phrase: 'Вакансии Повара', reason: expect.stringContaining('дубль') },
    ])
  })

  it('дедуп против existingMinus (по нормализации, с ё→е)', () => {
    const res = prepareMinusCandidates(['ЁЛКИ корпоратив'], {
      coreKeywords: core,
      existingMinus: ['елки корпоратив'],
    })
    expect(res.accepted).toEqual([])
    expect(res.rejected[0].reason).toContain('дубль')
  })
})

describe('pickDataDrivenMinusCandidates — правило (б)', () => {
  it('impressions ≥ порога И conversions === 0 → кандидат', () => {
    const rows = [
      makeRow({ query: 'мусорный запрос', impressions: MINUS_MIN_IMPRESSIONS, conversions: 0 }),
      makeRow({ query: 'конвертит', impressions: 500, conversions: 2 }),
      makeRow({ query: 'одиночный показ', impressions: MINUS_MIN_IMPRESSIONS - 1, conversions: 0 }),
    ]
    expect(pickDataDrivenMinusCandidates(rows)).toEqual(['мусорный запрос'])
  })
})

describe('recommendBid — бинарная шкала', () => {
  // Аукцион: премиум 100/85, шаг 75, вход 65, низ 15 (Bid/Price в микро).
  const auctionBids = [
    { TrafficVolume: 100, Bid: 900 * MICRO, Price: 850 * MICRO },
    { TrafficVolume: 85, Bid: 700 * MICRO, Price: 650 * MICRO },
    { TrafficVolume: 75, Bid: 200 * MICRO, Price: 180 * MICRO },
    { TrafficVolume: 65, Bid: 150 * MICRO, Price: 140 * MICRO },
    { TrafficVolume: 15, Bid: 50 * MICRO, Price: 40 * MICRO },
  ]

  it('конвертер (desiredTv=75) → шаг TV75', () => {
    const res = recommendBid({
      auctionBids,
      desiredTv: 75,
      currentBidMicro: 100 * MICRO,
    })
    expect(res).toEqual({ targetBidMicro: 200 * MICRO, targetTv: 75, changed: true })
  })

  it('вход в нижний блок (desiredTv=55) → наименьший TV ≥ 55 = 65', () => {
    const res = recommendBid({
      auctionBids,
      desiredTv: 55,
      currentBidMicro: 100 * MICRO,
    })
    expect(res).toEqual({ targetBidMicro: 150 * MICRO, targetTv: 65, changed: true })
  })

  it('горелка (desiredTv=15) → TV15 (низ, самый дешёвый)', () => {
    const res = recommendBid({
      auctionBids,
      desiredTv: 15,
      currentBidMicro: 100 * MICRO,
    })
    expect(res).toEqual({ targetBidMicro: 50 * MICRO, targetTv: 15, changed: true })
  })

  it('премиум (85/100) — НИКОГДА: цели 75 без позиции 75 не покупаем 85', () => {
    const withoutStep = auctionBids.filter((b) => b.TrafficVolume !== 75)
    const res = recommendBid({
      auctionBids: withoutStep,
      desiredTv: 75,
      currentBidMicro: 100 * MICRO,
    })
    expect(res.changed).toBe(false)
    expect(res.targetTv).toBeNull()
  })

  it('вход дороже потолка → не менять (changed=false, targetTv=null)', () => {
    const expensive = [{ TrafficVolume: 65, Bid: BID_CEILING_MICRO + MICRO, Price: BID_CEILING_MICRO }]
    const res = recommendBid({
      auctionBids: expensive,
      desiredTv: 55,
      currentBidMicro: 100 * MICRO,
    })
    expect(res).toEqual({
      targetBidMicro: 100 * MICRO,
      targetTv: null,
      changed: false,
      holdReason: 'ceiling',
    })
  })

  it('микрошум < 5% → не дёргаем ставку', () => {
    const res = recommendBid({
      auctionBids,
      desiredTv: 55,
      currentBidMicro: 147 * MICRO, // цель 150 — дельта ~2%
    })
    expect(res.changed).toBe(false)
  })

  it('пустой аукцион → не менять', () => {
    const res = recommendBid({
      auctionBids: [],
      desiredTv: 75,
      currentBidMicro: 100 * MICRO,
    })
    expect(res.changed).toBe(false)
  })
})

describe('pickBehavioralMinusCandidates (поведенческие кандидаты — предложением)', () => {
  const row = (o: Partial<{ phrase: string; visits: number; bounceRate: number; avgDurationSec: number; goalReaches: number }>) => ({
    phrase: 'фраза', visits: 5, bounceRate: 0, avgDurationSec: 60, goalReaches: 0, ...o,
  })

  it('≥3 визита, 0 заявок, высокий отказ → кандидат high_bounce', () => {
    const out = pickBehavioralMinusCandidates([row({ phrase: 'мусор кафе', bounceRate: 80 })])
    expect(out).toEqual([
      { phrase: 'мусор кафе', visits: 5, bounceRate: 80, avgDurationSec: 60, reason: 'high_bounce' },
    ])
  })

  it('≥3 визита, 0 заявок, мгновенный уход → кандидат short_duration', () => {
    const out = pickBehavioralMinusCandidates([row({ avgDurationSec: 8 })])
    expect(out[0].reason).toBe('short_duration')
  })

  it('и отказ, и мгновенный уход → high_bounce_short_duration', () => {
    const out = pickBehavioralMinusCandidates([row({ bounceRate: 90, avgDurationSec: 5 })])
    expect(out[0].reason).toBe('high_bounce_short_duration')
  })

  it('< порога визитов → НЕ кандидат (шум)', () => {
    expect(pickBehavioralMinusCandidates([row({ visits: 2, bounceRate: 90 })])).toEqual([])
  })

  it('есть заявка → НЕ кандидат (конвертит)', () => {
    expect(pickBehavioralMinusCandidates([row({ goalReaches: 1, bounceRate: 90 })])).toEqual([])
  })

  it('хорошее поведение (низкий отказ, долгий визит) → НЕ кандидат', () => {
    expect(pickBehavioralMinusCandidates([row({ bounceRate: 20, avgDurationSec: 120 })])).toEqual([])
  })
})

describe('checkCircuitBreaker', () => {
  it('пустой список → ок', () => {
    expect(checkCircuitBreaker([])).toEqual({ ok: true })
  })

  it('слишком много правок за тик → стоп', () => {
    const changes = Array.from({ length: CB_MAX_BID_CHANGES_PER_TICK + 1 }, () => ({
      fromMicro: 100 * MICRO,
      toMicro: 101 * MICRO,
    }))
    const res = checkCircuitBreaker(changes)
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('много правок')
  })

  it('РОСТ ставочной массы > порога → стоп (разгон расхода — вне паттерна)', () => {
    const res = checkCircuitBreaker([{ fromMicro: 100 * MICRO, toMicro: 200 * MICRO }])
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('масс')
  })

  it('СНИЖЕНИЕ ставочной массы на >50% → ОК (пофразный биддинг режет горелки — безопасно)', () => {
    // Цикл 2.0: снижение ставок расход не разгоняет → предохранитель не мешает.
    expect(checkCircuitBreaker([{ fromMicro: 200 * MICRO, toMicro: 40 * MICRO }]).ok).toBe(true)
    expect(
      checkCircuitBreaker([
        { fromMicro: 200 * MICRO, toMicro: 50 * MICRO },
        { fromMicro: 180 * MICRO, toMicro: 45 * MICRO },
      ]).ok
    ).toBe(true)
  })

  it('умеренная правка → ок', () => {
    expect(checkCircuitBreaker([{ fromMicro: 100 * MICRO, toMicro: 120 * MICRO }]).ok).toBe(true)
  })

  it('масса с нуля вверх → стоп (вне паттерна)', () => {
    expect(checkCircuitBreaker([{ fromMicro: 0, toMicro: 100 * MICRO }]).ok).toBe(false)
  })

  it('ЗАЛП после backfill: пачка конвертеров 40 ₽ → TV65 (150 ₽) — рост массы ×3.75 → CB стоп', () => {
    // М2: наполнение окон историей делает много фраз не-тонкими; на ближайшем тике
    // конвертеры разом поднимаются в нижний блок. Даже если правок ≤40, скачок
    // ставочной массы (275%) вне паттерна → circuit breaker останавливает пачку.
    const burst = Array.from({ length: 10 }, () => ({ fromMicro: 40 * MICRO, toMicro: 150 * MICRO }))
    const res = checkCircuitBreaker(burst)
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('масс')
  })
})

describe('isSuspiciousNegativesShrink — fail-safe усыхания минус-списка', () => {
  it('нет снапшота (null) → не судим', () => {
    expect(isSuspiciousNegativesShrink(0, null)).toBe(false)
    expect(isSuspiciousNegativesShrink(5, null)).toBe(false)
  })

  it('живой список внезапно ПУСТ, а в снапшоте были фразы → подозрительно (минуса сами не удаляются)', () => {
    expect(isSuspiciousNegativesShrink(0, 1178)).toBe(true)
    expect(isSuspiciousNegativesShrink(0, 5)).toBe(true) // даже малый список: 0 из ненуля
    expect(isSuspiciousNegativesShrink(0, 1)).toBe(true)
  })

  it('снапшот тоже 0 (молодая кампания без минусов) → не судим', () => {
    expect(isSuspiciousNegativesShrink(0, 0)).toBe(false)
  })

  it('потеря больше половины при осмысленной базе (≥20) → подозрительно', () => {
    expect(isSuspiciousNegativesShrink(500, 1178)).toBe(true) // 500 < 589
    expect(isSuspiciousNegativesShrink(600, 1178)).toBe(false) // 600 > 589 — норм. ручная чистка
  })

  it('малый список (база < 20): частичная усушка НЕ судится (кроме падения в 0)', () => {
    expect(isSuspiciousNegativesShrink(3, 10)).toBe(false) // 3 < 5, но база < 20 → не судим
    expect(isSuspiciousNegativesShrink(1, 19)).toBe(false)
  })

  it('рост списка (живой ≥ снапшота) → не подозрительно', () => {
    expect(isSuspiciousNegativesShrink(1179, 1178)).toBe(false)
    expect(isSuspiciousNegativesShrink(1178, 1178)).toBe(false)
  })
})
