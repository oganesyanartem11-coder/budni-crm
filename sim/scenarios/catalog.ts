/**
 * КАТАЛОГ СЦЕНАРИЕВ полигона Бориса-Директа.
 *
 * buildCatalog(baseSeed) → 24 tuning (T01–T24) + 6 holdout (H01–H06).
 * Tuning — сценарии, на которых Бориса калибруют и разбирают ошибки.
 * Holdout — проверка обобщения: вариации с другими маркерами/группами и
 * ТРИ новых типа событий, не встречающихся в tuning (H04–H06).
 *
 * Нумерация: CTR-тройка из задания (объявления/позиция/охват) занята под
 * T15/T16/T17, поэтому лаг/режим/жемчужина/разметка/каннибализация сдвинуты
 * в T18–T22, катастрофа расхода — T23, цикл владельца — T24. Итого 24 ≥ 22.
 *
 * Детерминизм: вся случайность — из mulberry32 (builders). У каждого
 * сценария СВОЙ rng от (baseSeed, порядковый номер): правки одного сценария
 * не сдвигают джиттер остальных. Math.random и Date запрещены.
 *
 * У каждого сценария честные expectations:
 *  - causeCodes: истинные коды КЛЮЧЕВЫХ ситуаций ('campaign' | 'adgroup:G2'
 *    | 'keyword:1013' | 'query:<текст>') — их сверяет скорер;
 *  - anomalies: что обязан заметить идеальный аналитик (день + род);
 *  - notes: чему учит ловушка (попадает в отчёт разбора ошибок).
 */

import type {
  PhraseSpec,
  QuerySpec,
  ReasonCode,
  ScenarioConfig,
  ScenarioExpectations,
  ScenarioSet,
  TrashQuerySpec,
  WorldEvent,
} from '../types'
import {
  BASE_CONVERSION_LAG,
  BASE_WEEKDAY_DEMAND,
  BASE_YCLID_LOSS,
  DISPUTED_QUERY_POOL,
  TARGET_QUERY_VARIATIONS,
  TRASH_QUERY_POOL,
  type Rng,
  clamp,
  jitter,
  jitterInt,
  keywordIdOf,
  makeAds,
  makeCpcByTv,
  makeCtrByTv,
  makeDisputedQuery,
  makePhraseSet,
  makeTargetQuery,
  makeTrashQuery,
  makeTrashTail,
  mulberry32,
  round4,
} from './builders'

// ============================================================
// Наборы индексов пула фраз (масштаб: 20–40 фраз, все 4 группы)
// ============================================================

/** Диапазон целых [a..b] включительно. */
function range(a: number, b: number): number[] {
  const out: number[] = []
  for (let i = a; i <= b; i++) out.push(i)
  return out
}

const G1_MID = [0, 1, 2, 3, 4, 5] // Офисы: ядро 0–4 + хвост 5
const G2_MID = [12, 13, 14, 15, 16, 17] // Стройки: ядро 12–14 + хвост
const G8_MID = [20, 21, 22, 23, 24, 25] // Склады: ядро 20–22 + хвост
const G4_MID = [28, 29, 30, 31, 32, 33] // Мероприятия: ядро 28,29,31 + хвост

/** Стандартная кампания: 24 фразы, по 6 на группу. */
const MID_24 = [...G1_MID, ...G2_MID, ...G8_MID, ...G4_MID]

/** Ядровые индексы MID_24 (для сценариев про ядро: T08, H06). */
const MID_24_CORE = [0, 1, 2, 3, 4, 12, 13, 14, 20, 21, 22, 28, 29, 31]

/** Широкая кампания: 36 фраз (для длинных/сезонных сценариев). */
const FULL_36 = [...range(0, 11), ...range(12, 19), ...range(20, 27), ...range(28, 35)]

/** Малая кампания: 20 фраз (карантин). */
const SMALL_20 = [0, 1, 2, 3, 4, 12, 13, 14, 15, 16, 20, 21, 22, 23, 24, 28, 29, 30, 31, 32]

// ============================================================
// Общие помощники сборки
// ============================================================

/** Копия базовой недельной сезонности (мутабельный кортеж для конфига). */
function weekdays(): ScenarioConfig['weekdayDemand'] {
  return [...BASE_WEEKDAY_DEMAND] as ScenarioConfig['weekdayDemand']
}

/** Черновик сценария: обязательные поля + отличия от базовой калибровки. */
interface Draft {
  id: string
  name: string
  set: ScenarioSet
  days: number
  phrases: PhraseSpec[]
  cpcByTv: Record<number, number>
  ads: ScenarioConfig['ads']
  expectations: ScenarioExpectations
  queries?: QuerySpec[]
  events?: WorldEvent[]
  quarantineUntilDay?: number
  conversionLagDays?: Record<number, number>
  yclidLossRate?: number
}

/** Сборка ScenarioConfig с базовыми умолчаниями калибровки (без draw'ов RNG). */
function finish(d: Draft): ScenarioConfig {
  return {
    id: d.id,
    name: d.name,
    set: d.set,
    days: d.days,
    quarantineUntilDay: d.quarantineUntilDay ?? 0,
    phrases: d.phrases,
    queries: d.queries ?? [],
    ads: d.ads,
    events: d.events ?? [],
    weekdayDemand: weekdays(),
    conversionLagDays: d.conversionLagDays ?? { ...BASE_CONVERSION_LAG },
    yclidLossRate: d.yclidLossRate ?? BASE_YCLID_LOSS,
    cpcByTv: d.cpcByTv,
    expectations: d.expectations,
  }
}

/**
 * Пара живых запросов-вариаций с малой долей — «жизнь» мира. Минусовать их
 * нельзя ни в одном сценарии (оракул кладёт их в mustKeep по isTrash=false).
 * Доли фиксированы малыми, чтобы не подпирать инвариант Σshare ≤ 0.6.
 */
function standardVariations(rng: Rng): QuerySpec[] {
  return [
    makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[1], [keywordIdOf(0)], { share: 0.05 }),
    makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[4], [keywordIdOf(12)], { share: 0.05 }),
  ]
}

/** Пометить N самых жирных по доле мусорных запросов истинным кодом STRUCTURAL_TRASH. */
function markTopTrash(queries: QuerySpec[], n: number, into: Record<string, ReasonCode>): void {
  const trash = queries.filter((q): q is TrashQuerySpec => q.isTrash)
  const top = [...trash].sort((a, b) => b.share - a.share || (a.query < b.query ? -1 : 1)).slice(0, n)
  for (const t of top) into[`query:${t.query}`] = 'STRUCTURAL_TRASH'
}

/** Топ-N ядровых фраз по спросу (тай-брейк по keywordId — детерминизм). */
function topCoreByDemand(phrases: PhraseSpec[], n: number): PhraseSpec[] {
  return phrases
    .filter((p) => p.isCore)
    .sort((a, b) => b.demandPerDay - a.demandPerDay || a.keywordId - b.keywordId)
    .slice(0, n)
}

/**
 * Групповые переопределения: «конверсия ≈ 0» (FORM_DROPOFF / DATA_NO_CONV).
 * Визиты при этом остаются нормального качества — их движок моделирует сам.
 */
function nearZeroCrOverrides(rng: Rng, poolIndexes: number[]): Record<number, Partial<PhraseSpec>> {
  const over: Record<number, Partial<PhraseSpec>> = {}
  for (const pi of poolIndexes) {
    over[pi] = { trueCr: round4(clamp(jitter(rng, 0.001, 0.5), 0.0003, 0.002)) }
  }
  return over
}

/**
 * Групповые переопределения: «дорогая группа» — ставка ~218 ₽ гарантирует
 * премиум-уровень 85 (цена входа 85 джиттерится в 175–205 ₽ < 211 ₽).
 */
function premiumBidOverrides(rng: Rng, poolIndexes: number[]): Record<number, Partial<PhraseSpec>> {
  const over: Record<number, Partial<PhraseSpec>> = {}
  for (const pi of poolIndexes) {
    over[pi] = { startBidMicro: jitterInt(rng, 218, 0.03) * 1_000_000 }
  }
  return over
}

// ============================================================
// TUNING: T01–T24
// ============================================================

/** T01. Здоровая кампания: лучший план действий — почти пустой. */
function t01(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  const queries = [
    ...standardVariations(rng),
    makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[6], [keywordIdOf(20)], { share: 0.04 }),
  ]
  const ads = makeAds(rng)
  return finish({
    id: 'T01',
    name: 'Здоровая кампания',
    set: 'tuning',
    days: 21,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: {},
      anomalies: [],
      notes:
        'Мир здоров: фразы в норме, мусора нет, событий нет. Урок — дисциплина покоя: ' +
        'штрафуются лишние движения (минусовать живые вариации, дёргать ставки без ' +
        'статистической причины, тревоги на ровном месте). Идеальный Борис делает ' +
        'считанные аккуратные шаги или не делает их вовсе — и не портит работающую экономику.',
    },
  })
}

/** T02. Мусорный хвост ~30% показов с явными маркерами (срез A пула). */
function t02(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  // Срез A (города-1/бесплатно/рецепты/вакансии) + часть среза C: 23 запроса,
  // средняя доля ~0.15 × 2 прилипания ≈ 29% показов кампании уходит в мусор.
  const trash = makeTrashTail(rng, [...range(0, 14), 30, 31, 32, 33, 34, 35, 36, 38], phrases, {
    shareBase: 0.15,
    sharePct: 0.3,
    sticks: 2,
    maxPerKeyword: 0.4,
  })
  const queries = [...trash, ...standardVariations(rng)]
  const ads = makeAds(rng)
  const causeCodes: Record<string, ReasonCode> = {}
  markTopTrash(queries, 5, causeCodes)
  return finish({
    id: 'T02',
    name: 'Мусорный хвост ~30%',
    set: 'tuning',
    days: 18,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes,
      anomalies: [],
      notes:
        '~30% показов съедает структурный мусор с явными маркерами: чужие города (казань, ' +
        'екатеринбург, спб…), «бесплатно», «рецепт», «вакансии», «б/у», «скачать». Урок — ' +
        'гигиена поискового отчёта: распознать маркеры и заминусовать мусор ФРАЗАМИ, не задев ' +
        'живые вариации. Коды выставлены на самые жирные по доле запросы; остальной мусор ' +
        'подлежит чистке по мере набора данных.',
    },
  })
}

/** T03. Дорогая группа без конверсий: G8 жжёт премиум-бюджет впустую. */
function t03(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const over = {
    ...nearZeroCrOverrides(rng, G8_MID),
  }
  for (const pi of G8_MID) over[pi] = { ...over[pi], ...premiumBidOverrides(rng, [pi])[pi] }
  const phrases = makePhraseSet(rng, MID_24, over)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  return finish({
    id: 'T03',
    name: 'Дорогая группа без конверсий (G8)',
    set: 'tuning',
    days: 18,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: { 'adgroup:G8': 'DATA_NO_CONV' },
      anomalies: [],
      notes:
        'Группа G8 (Склады) закупает премиум-трафик (~190–205 ₽ за клик, уровень 85) с ' +
        'конверсией ≈0: расход растёт, заявок нет. Урок DATA_NO_CONV: увидеть жжение денег ' +
        'за период, не резать в панике на второй день, но и не ждать месяц — после ' +
        'достаточной статистики опустить ставки/уровень группы. Ловушка симметрична T14: ' +
        'дорогой клик сам по себе не приговор — приговор дорогой клик БЕЗ заявок.',
    },
  })
}

/** T04. Пара-ловушка: бот-волна на двух фразах ПРОТИВ группы с отвалом на форме. */
function t04(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  // G1 даёт отличные визиты, но заявок ≈0 — отвал на форме/оффере.
  const phrases = makePhraseSet(rng, MID_24, nearZeroCrOverrides(rng, G1_MID))
  const queries = [
    makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[6], [keywordIdOf(20)], { share: 0.05 }),
    makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[8], [keywordIdOf(28)], { share: 0.05 }),
  ]
  const ads = makeAds(rng)
  const botKw1 = keywordIdOf(12)
  const botKw2 = keywordIdOf(13)
  const events: WorldEvent[] = [
    // Дни 4–9 включительно: клики без визитов по двум фразам G2.
    { kind: 'bot_wave', day: 4, days: 6, keywordIds: [botKw1, botKw2], clicksPerDay: jitterInt(rng, 24, 0.2) },
  ]
  return finish({
    id: 'T04',
    name: 'Пара-ловушка: боты против отвала форм',
    set: 'tuning',
    days: 16,
    phrases,
    queries,
    ads,
    events,
    cpcByTv,
    expectations: {
      causeCodes: {
        [`keyword:${botKw1}`]: 'BOT_TRAFFIC',
        [`keyword:${botKw2}`]: 'BOT_TRAFFIC',
        'adgroup:G1': 'FORM_DROPOFF',
      },
      anomalies: [{ day: 5, kind: 'clicks' }],
      notes:
        'Пара-ловушка на различение диагнозов. Дни 4–9 боты кликают две фразы G2: клики и ' +
        'расход растут, а ВИЗИТОВ в Метрике по ним нет — это BOT_TRAFFIC, не повод трогать ' +
        'тексты или ставки. Параллельно группа G1 весь прогон даёт отличные визиты (глубина, ' +
        'доход до формы), но заявок ≈0 — это FORM_DROPOFF: чинить оффер/форму, а не трафик. ' +
        'Одинаковое «нет заявок» имеет разные первопричины и разные правильные действия.',
    },
  })
}

/** T05. Отвал заявок: форма ломается в d8 и чинится в d13. */
function t05(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  const events: WorldEvent[] = [
    { kind: 'form_break', day: 8 },
    { kind: 'form_fix', day: 13 },
  ]
  return finish({
    id: 'T05',
    name: 'Отвал заявок: сломалась форма',
    set: 'tuning',
    days: 18,
    phrases,
    queries,
    ads,
    events,
    cpcByTv,
    expectations: {
      causeCodes: { campaign: 'FORM_DROPOFF' },
      anomalies: [{ day: 9, kind: 'leads' }],
      notes:
        'День 8 — форма на сайте ломается: визиты идут, их качество прежнее, а заявки разом ' +
        'обнуляются по ВСЕЙ кампании. День 13 — форму чинят. Урок: синхронный обвал заявок ' +
        'при живом трафике — не «фразы испортились»; резать ставки или минусовать в эти дни — ' +
        'ошибка. Правильно: заметить аномалию дня 9, диагностировать FORM_DROPOFF уровня ' +
        'кампании, бить тревогу владельцу и не портить структуру.',
    },
  })
}

/** T06. Сезонный провал: спрос ×0.4 на неделю, правильное действие — ничего. */
function t06(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, FULL_36)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  const events: WorldEvent[] = [{ kind: 'demand_dip', day: 7, days: 7, multiplier: 0.4 }]
  return finish({
    id: 'T06',
    name: 'Сезонный провал спроса',
    set: 'tuning',
    days: 21,
    phrases,
    queries,
    ads,
    events,
    cpcByTv,
    expectations: {
      causeCodes: { campaign: 'SEASONAL_DIP_HOLD' },
      anomalies: [{ day: 8, kind: 'demand' }],
      notes:
        'С дня 7 на неделю спрос проседает до ×0.4 (сезонная яма). Показы и заявки падают ' +
        'ВЕЗДЕ пропорционально, CTR и CR фраз не меняются. Урок SEASONAL_DIP_HOLD: правильное ' +
        'действие — ничего. Паника (снижение ставок, чистка «переставших работать» фраз) ' +
        'фиксирует убыток и ломает кампанию к моменту возврата спроса.',
    },
  })
}

/** T07. Карантин молодой кампании: 10 дней, мало данных, наблюдать. */
function t07(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const over: Record<number, Partial<PhraseSpec>> = {}
  for (const pi of SMALL_20) over[pi] = { demandPerDay: clamp(jitterInt(rng, 18, 0.25), 10, 26) }
  const phrases = makePhraseSet(rng, SMALL_20, over)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  return finish({
    id: 'T07',
    name: 'Карантин молодой кампании',
    set: 'tuning',
    days: 10,
    quarantineUntilDay: 5,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: { campaign: 'QUARANTINE_HOLD' },
      anomalies: [],
      notes:
        'Молодая кампания в карантине до дня 5, прогон всего 10 дней, спрос скромный — ' +
        'данных мало по каждой фразе. Урок QUARANTINE_HOLD: в карантине наблюдать, не ' +
        'выносить приговоров по 3–5 кликам, не гонять ставки. Ранние «выводы» здесь почти ' +
        'всегда статистический шум, а цена суеты — сломанная стартовая калибровка.',
    },
  })
}

/** T08. Аукцион дорожает ×2.5: премиум уходит за потолок 400 ₽. */
function t08(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  // Ядро со ставкой ~168 ₽: до дрейфа уровень 75, после ×2.5 продолжает
  // держать 75 (цена 138–163 ₽), но вход в 85/100 теперь 437–650 ₽ > 400 ₽.
  const over: Record<number, Partial<PhraseSpec>> = {}
  for (const pi of MID_24_CORE) over[pi] = { startBidMicro: jitterInt(rng, 168, 0.03) * 1_000_000 }
  const phrases = makePhraseSet(rng, MID_24, over)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  const events: WorldEvent[] = [{ kind: 'auction_drift', day: 5, priceMultiplier: 2.5 }]
  const causeCodes: Record<string, ReasonCode> = {}
  for (const p of topCoreByDemand(phrases, 3)) causeCodes[`keyword:${p.keywordId}`] = 'AUCTION_ABOVE_CEILING'
  return finish({
    id: 'T08',
    name: 'Аукцион дорожает ×2.5',
    set: 'tuning',
    days: 18,
    phrases,
    queries,
    ads,
    events,
    cpcByTv,
    expectations: {
      causeCodes,
      anomalies: [{ day: 6, kind: 'traffic' }],
      notes:
        'День 5 — аукцион дорожает ×2.5. Ядро (ставки ~168 ₽) удерживает уровень 75, но вход ' +
        'в премиум 85/100 теперь 440–650 ₽ — дороже потолка 400 ₽: по топовым фразам ядра ' +
        'истинный код AUCTION_ABOVE_CEILING — держаться на 65/75 и не гнаться. Хвост со ' +
        'ставками ~52 ₽ оказывается ниже подорожавшего входа и гаснет — это видно по странице ' +
        'ставок (цены уровней выросли), а не по «испортившимся» фразам. Урок: сначала смотри ' +
        'на цены аукциона, потом на фразы.',
    },
  })
}

/** T09. Звезда-конвертер в хвосте: нецелевая на вид фраза с CR 0.10. */
function t09(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const starIdx = 5 // «доставка бизнес ланчей в офис», не-ядро G1
  const over: Record<number, Partial<PhraseSpec>> = {
    [starIdx]: {
      trueCr: round4(clamp(jitter(rng, 0.1, 0.08), 0.09, 0.11)),
      demandPerDay: clamp(jitterInt(rng, 42, 0.2), 30, 60),
    },
  }
  const phrases = makePhraseSet(rng, MID_24, over)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  return finish({
    id: 'T09',
    name: 'Звезда-конвертер в хвосте',
    set: 'tuning',
    days: 21,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: { [`keyword:${keywordIdOf(starIdx)}`]: 'PROVEN_CONVERTER_VOLUME' },
      anomalies: [],
      notes:
        'В хвосте прячется звезда: не-ядровая фраза «доставка бизнес ланчей в офис» (1006) ' +
        'конвертит с CR≈0.10 — вдвое-втрое выше ядра. Урок PROVEN_CONVERTER_VOLUME: ' +
        'доказанному конвертеру дают объём (уровень 75) невзирая на «хвостовой» статус. ' +
        'Противоположная ошибка — стричь кампанию по формальному ядру и держать звезду на ' +
        'минимальном уровне.',
    },
  })
}

/** T10. Боевой микс: мусор + дорогая группа + короткая поломка формы. */
function t10(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const over = {
    ...nearZeroCrOverrides(rng, G8_MID),
  }
  for (const pi of G8_MID) over[pi] = { ...over[pi], ...premiumBidOverrides(rng, [pi])[pi] }
  const phrases = makePhraseSet(rng, MID_24, over)
  const trash = makeTrashTail(rng, [39, 40, 41, 42, 43, 44, 45, 46], phrases, {
    shareBase: 0.07,
    sharePct: 0.3,
    sticks: 2,
    maxPerKeyword: 0.35,
  })
  const queries = [...trash, ...standardVariations(rng)]
  const ads = makeAds(rng)
  const events: WorldEvent[] = [
    { kind: 'form_break', day: 9 },
    { kind: 'form_fix', day: 11 },
  ]
  const causeCodes: Record<string, ReasonCode> = {
    'adgroup:G8': 'DATA_NO_CONV',
    campaign: 'FORM_DROPOFF',
  }
  markTopTrash(queries, 3, causeCodes)
  return finish({
    id: 'T10',
    name: 'Боевой микс',
    set: 'tuning',
    days: 20,
    phrases,
    queries,
    ads,
    events,
    cpcByTv,
    expectations: {
      causeCodes,
      anomalies: [{ day: 10, kind: 'leads' }],
      notes:
        'Три задачи сразу: умеренный мусорный хвост (похудение, посуда, чужие бренды), ' +
        'дорогая группа G8 с конверсией ≈0 и короткая поломка формы (дни 9–10). Урок — ' +
        'приоритизация и несмешение диагнозов: сначала остановить жжение денег (G8), ' +
        'параллельно распознать, что провал заявок дней 9–10 общий и временный (форма), а не ' +
        'повод перекраивать ставки; мусор чистить по ходу. Три причины — три разных ответа.',
    },
  })
}

/** T11. «Слабая на вид»: низкий CTR, дорогой клик — но стабильные заявки. */
function t11(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const weakIdx = 25 // «доставка обедов на производство подмосковье», не-ядро G8
  const over: Record<number, Partial<PhraseSpec>> = {
    [weakIdx]: {
      trueCtrByTv: makeCtrByTv(rng, 0.62), // CTR заметно ниже кривой соседей
      trueCr: round4(clamp(jitter(rng, 0.065, 0.12), 0.055, 0.075)),
      demandPerDay: clamp(jitterInt(rng, 60, 0.15), 45, 75),
      startBidMicro: jitterInt(rng, 230, 0.03) * 1_000_000, // премиум-уровень: дорогой клик
    },
  }
  const phrases = makePhraseSet(rng, MID_24, over)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  return finish({
    id: 'T11',
    name: 'Слабая на вид — конвертит',
    set: 'tuning',
    days: 21,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: { [`keyword:${keywordIdOf(weakIdx)}`]: 'PROVEN_CONVERTER_VOLUME' },
      anomalies: [],
      notes:
        'Фраза 1026 выглядит слабой: CTR ниже соседей, клик премиальный и дорогой, CPL выше ' +
        'среднего. Но заявки с неё идут СТАБИЛЬНО весь прогон, и клик в пределах потолка ' +
        '400 ₽. Урок: «дорого и некрасиво» ≠ «плохо» — это доказанный конвертер, дающий ' +
        'объём; резать его = потерять заявки, которые нечем заместить. Код ' +
        'PROVEN_CONVERTER_VOLUME: держать и давать трафик, а не наказывать за внешность.',
    },
  })
}

/** T12. Ловушка атрибуции: 35% заявок теряют yclid. */
function t12(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  return finish({
    id: 'T12',
    name: 'Ловушка атрибуции: потеря yclid 35%',
    set: 'tuning',
    days: 21,
    phrases,
    queries,
    ads,
    cpcByTv,
    yclidLossRate: 0.35,
    expectations: {
      causeCodes: { campaign: 'NOISE_HOLD' },
      anomalies: [],
      notes:
        'Треть заявок (35%) теряет yclid и не привязывается к фразам/запросам. Пофразный CPL ' +
        'систематически врёт: заявки есть — привязки нет, «лучшие» и «худшие» фразы по ' +
        'атрибуции наполовину иллюзия. Урок честной осторожности: решения — только по ' +
        'устойчивым агрегатам (группа/кампания) и длинным окнам; вклад фраз в отчётах — с ' +
        'явной оговоркой о непознаваемой трети. NOISE_HOLD: не действовать от шумной ' +
        'пофразной картинки и не выдавать догадку за атрибуцию.',
    },
  })
}

/** T13. Первопричина — оффер: G4 с отличными визитами и CR≈0.001. */
function t13(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24, nearZeroCrOverrides(rng, G4_MID))
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  return finish({
    id: 'T13',
    name: 'Первопричина — оффер (G4)',
    set: 'tuning',
    days: 18,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: { 'adgroup:G4': 'FORM_DROPOFF' },
      anomalies: [],
      notes:
        'Группа G4 (Мероприятия) даёт отличные визиты — глубина 2–6 страниц, нормальный ' +
        'доход до формы — а заявок ≈0 весь прогон. Трафик хорош, экономика группы мертва. ' +
        'Урок: первопричина не в закупке (ставки, тексты и запросы в норме), а в ' +
        'оффере/форме под мероприятия — FORM_DROPOFF уровня группы. Правильное действие — ' +
        'сигнал владельцу о посадочной/оффере, а не орудование ставками и минусами.',
    },
  })
}

/** T14. Дорогая по кликам — дешёвая по заявкам: у G2 максимальный CPC и CR ×3. */
function t14(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const over: Record<number, Partial<PhraseSpec>> = {}
  for (const pi of G2_MID) {
    over[pi] = {
      startBidMicro: jitterInt(rng, 165, 0.03) * 1_000_000, // стабильный уровень 75 — самый дорогой клик кампании
      trueCr: round4(clamp(jitter(rng, 0.1, 0.12), 0.085, 0.12)), // CR ×3 от типового
    }
  }
  const phrases = makePhraseSet(rng, MID_24, over)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  return finish({
    id: 'T14',
    name: 'Дорогая по кликам — дешёвая по заявкам (G2)',
    set: 'tuning',
    days: 21,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: { 'adgroup:G2': 'PROVEN_CONVERTER_VOLUME' },
      anomalies: [],
      notes:
        'Группа G2 (Стройки) — самый дорогой клик кампании (уровень 75, ~60 ₽ против ~45 ₽ у ' +
        'прочих), и при этом CR≈0.10: заявка обходится ДЕШЕВЛЕ всех (~600 ₽ против ~1400 ₽). ' +
        'Урок: смотреть на цену ЗАЯВКИ, а не клика. Резать самую дорогую по кликам группу = ' +
        'зарезать лучший генератор заявок. PROVEN_CONVERTER_VOLUME: дорогим кликам с дешёвой ' +
        'заявкой дают объём.',
    },
  })
}

/** T15. CTR-ловушка №1 — тексты: у G1 все объявления качества 0.45. */
function t15(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  const queries = standardVariations(rng)
  const ads = makeAds(rng, { textQualityByGroup: { G1: 0.45 } })
  return finish({
    id: 'T15',
    name: 'Плохие тексты объявлений (G1)',
    set: 'tuning',
    days: 18,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: { 'adgroup:G1': 'AD_TEXT_PROBLEM' },
      anomalies: [],
      notes:
        'У группы G1 все тексты объявлений слабые (качество ≈0.45): CTR вдвое ниже ' +
        'ожидаемого ПРИ НОРМАЛЬНОЙ позиции — ставки и достигнутые уровни те же, что у ' +
        'прочих групп (видно по странице ставок). Урок AD_TEXT_PROBLEM: различать «низкий ' +
        'CTR из-за позиции» и «низкий CTR из-за текста»; здесь лечится текстом, а подъём ' +
        'ставок лишь удорожает те же слабые клики.',
    },
  })
}

/** T16. CTR-ловушка №2 — позиция: ставки G2 ниже цены входа в уровень 15. */
function t16(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  // Ставка ~62% от цены минимального уровня: показов у группы нет вовсе.
  const lowBidRub = Math.max(2, Math.round(cpcByTv[15] * 0.62))
  const over: Record<number, Partial<PhraseSpec>> = {}
  for (const pi of G2_MID) over[pi] = { startBidMicro: jitterInt(rng, lowBidRub, 0.06) * 1_000_000 }
  const phrases = makePhraseSet(rng, MID_24, over)
  const queries = [
    makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[1], [keywordIdOf(0)], { share: 0.05 }),
    makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[6], [keywordIdOf(20)], { share: 0.04 }),
  ]
  const ads = makeAds(rng)
  return finish({
    id: 'T16',
    name: 'Ставки ниже входа (G2)',
    set: 'tuning',
    days: 18,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: { 'adgroup:G2': 'POSITION_TOO_LOW' },
      anomalies: [],
      notes:
        'Ставки группы G2 (~15 ₽) ниже цены входа даже в минимальный уровень 15 (~25 ₽): ' +
        'показов у группы ПРОСТО НЕТ. Страница ставок прямо показывает: ставка меньше цены ' +
        'любого уровня аукциона. Урок POSITION_TOO_LOW: нулевой трафик группы при живом ' +
        'спросе и нормальных текстах — вопрос к ставке, а не к текстам или минусам; лечится ' +
        'подъёмом до входа. Не путать с LOW_COVERAGE (там ставки в норме, но мал спрос).',
    },
  })
}

/** T17. CTR-ловушка №3 — охват: у G8 спрос 5–8 показов в день. */
function t17(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const over: Record<number, Partial<PhraseSpec>> = {}
  for (const pi of G8_MID) over[pi] = { demandPerDay: clamp(jitterInt(rng, 6.5, 0.25), 5, 8) }
  const phrases = makePhraseSet(rng, MID_24, over)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  return finish({
    id: 'T17',
    name: 'Мало охвата (G8)',
    set: 'tuning',
    days: 21,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: { 'adgroup:G8': 'LOW_COVERAGE' },
      anomalies: [],
      notes:
        'Группа G8 показывается нормально (уровни достигнуты, тексты в порядке), но спрос по ' +
        'её фразам — 5–8 показов в день: данных ничтожно мало, любые CTR/CR по группе — шум. ' +
        'Урок LOW_COVERAGE: узкое место — охват, а не качество; не выносить приговоров по ' +
        'двум кликам, расширять семантику или ждать. Не путать с POSITION_TOO_LOW (там ' +
        'показов нет из-за ставки — здесь ставки в норме).',
    },
  })
}

/** T18. Запаздывающие конверсии: пик заявок на 2–3-й день, хвост до недели. */
function t18(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  return finish({
    id: 'T18',
    name: 'Запаздывающие конверсии',
    set: 'tuning',
    days: 24,
    phrases,
    queries,
    ads,
    cpcByTv,
    conversionLagDays: { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.2, 5: 0.15, 7: 0.05 },
    expectations: {
      causeCodes: { campaign: 'NOISE_HOLD' },
      anomalies: [],
      notes:
        'Конверсии запаздывают: лишь 10% заявок приходит в день клика, пик — на 2–3-й день, ' +
        'хвост тянется до недели. Первую неделю любой срез «клики есть — заявок нет» ' +
        'выглядит как DATA_NO_CONV, и это ложь: Директ допишет конверсии в старые строки ' +
        'задним числом. Урок: окно оценки обязано превышать лаг; свежие дни в отчётах ' +
        'заведомо неполные; ранние приговоры фразам запрещены — NOISE_HOLD до созревания данных.',
    },
  })
}

/** T19. Смена режима: G2 ломается навсегда с дня 10 (сценарий памяти). */
function t19(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, FULL_36)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  const events: WorldEvent[] = [{ kind: 'regime_change', day: 10, adGroupId: 'G2', newCrMultiplier: 0.15 }]
  return finish({
    id: 'T19',
    name: 'Смена режима: G2 ломается с дня 10',
    set: 'tuning',
    days: 24,
    phrases,
    queries,
    ads,
    events,
    cpcByTv,
    expectations: {
      causeCodes: { 'adgroup:G2': 'REGIME_CHANGE' },
      anomalies: [{ day: 12, kind: 'leads' }],
      notes:
        '[память] До дня 10 группа G2 — исправный конвертер; с дня 10 её экономика ломается ' +
        'навсегда (CR ×0.15): мир СМЕНИЛ РЕЖИМ. Урок памяти: вывод «G2 работает», сделанный ' +
        'до перелома, обязан быть пересмотрен по свежим данным — это REGIME_CHANGE, а не ' +
        '«шум, подождём». Симметрично: не переписывать историю до дня 10 — тогда группа ' +
        'работала честно, и ранние решения по ней были верными.',
    },
  })
}

/** T20. Скрытая жемчужина: ставка ниже входа — показов нет, а CR 0.09. */
function t20(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const gemIdx = 17 // «питание рабочих на стройке москва», не-ядро G2
  const gemBidRub = Math.max(2, Math.round(cpcByTv[15] * 0.55))
  const over: Record<number, Partial<PhraseSpec>> = {
    [gemIdx]: {
      startBidMicro: jitterInt(rng, gemBidRub, 0.05) * 1_000_000,
      trueCr: round4(clamp(jitter(rng, 0.09, 0.08), 0.08, 0.1)),
      demandPerDay: clamp(jitterInt(rng, 36, 0.2), 25, 50),
    },
  }
  const phrases = makePhraseSet(rng, MID_24, over)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  return finish({
    id: 'T20',
    name: 'Скрытая жемчужина',
    set: 'tuning',
    days: 18,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: { [`keyword:${keywordIdOf(gemIdx)}`]: 'EXPLORATION' },
      anomalies: [],
      notes:
        'Фраза 1018 со ставкой ниже входа (~14 ₽ < ~25 ₽) не имеет НИ ОДНОГО показа — а её ' +
        'истинная CR 0.09, лучшая в кампании. По нулям показов «данных нет» — и именно ' +
        'поэтому код EXPLORATION: недооткрученное надо разведывать малой ставкой (вход в ' +
        '15-й уровень), а не считать мёртвым. Урок: отсутствие данных ≠ отсутствие ценности; ' +
        'бюджет разведки — часть дисциплины, а не роскошь.',
    },
  })
}

/** T21. Противоречие источников: слетела разметка Метрики. */
function t21(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  const events: WorldEvent[] = [{ kind: 'metrica_tag_off', day: 6 }]
  return finish({
    id: 'T21',
    name: 'Противоречие источников: слетела разметка',
    set: 'tuning',
    days: 18,
    phrases,
    queries,
    ads,
    events,
    cpcByTv,
    expectations: {
      causeCodes: { campaign: 'DATA_MISMATCH' },
      anomalies: [{ day: 7, kind: 'mismatch' }],
      notes:
        'День 6 — слетает разметка (addMetricaTag=NO): у новых заявок пропадают yclid и utm, ' +
        'разрез по фразам в Метрике пустеет, а Директ ПРОДОЛЖАЕТ писать конверсии в отчёт. ' +
        'Источники противоречат друг другу — DATA_MISMATCH: зафлагать, починить разметку ' +
        '(metrica_tag_restore) и НЕ принимать решений по битому окну данных. Урок: сначала ' +
        'проверь измерение, потом суди мир.',
    },
  })
}

/** T22. Каннибализация минусом: «работа» (вакансии) против «на работу» (клиенты). */
function t22(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  const kwA = keywordIdOf(0) // «доставка обедов в офис»
  const kwB = keywordIdOf(3) // «обеды в офис с доставкой»
  const queries: QuerySpec[] = [
    // Мусор-вакансии: «доставка обедов работа» — ищут работу, не обеды.
    makeTrashQuery(rng, 37, [kwA, kwB], { share: 0.16, trueCtr: 0.025 }),
    makeTrashQuery(rng, 11, [kwA], { share: 0.05 }), // «работа курьером доставка обедов»
    makeTrashQuery(rng, 10, [keywordIdOf(1)], { share: 0.05 }), // «вакансии повара корпоративное питание»
    // Живой близнец: «доставка обедов на работу» — ищут НАС. Минусовать нельзя.
    makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[0], [kwA, kwB], { share: 0.12, trueCr: 0.06 }),
    makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[3], [keywordIdOf(2)], { share: 0.05 }),
  ]
  const ads = makeAds(rng)
  return finish({
    id: 'T22',
    name: 'Каннибализация минусом: работа vs на работу',
    set: 'tuning',
    days: 18,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: {
        [`query:${TRASH_QUERY_POOL[37]}`]: 'STRUCTURAL_TRASH',
        [`query:${TRASH_QUERY_POOL[11]}`]: 'STRUCTURAL_TRASH',
        [`query:${TRASH_QUERY_POOL[10]}`]: 'STRUCTURAL_TRASH',
      },
      anomalies: [],
      notes:
        'Каннибализация минусом: мусор «доставка обедов работа» (ищут вакансии) живёт рядом ' +
        'с живым «доставка обедов на работу» (ищут нас), рядом ещё вакансийный мусор про ' +
        'курьеров и поваров — соблазн однословного минуса «работа» велик. Правильный минус — ' +
        'ФРАЗОЙ ЦЕЛИКОМ: «доставка обедов работа». Однословный минус «работа» в реальном ' +
        'Директе режет и словоформу «работу», то есть живой запрос, а кампейн-левел ' +
        'растиражирует ущерб на все группы. Полигон словоформы не моделирует, но дисциплину ' +
        '«минусуй фразой, не словом» прививает именно эта ловушка.',
    },
  })
}

/** T23. Катастрофа расхода: внутридневной взрыв цены клика ×2.2. */
function t23(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  const events: WorldEvent[] = [{ kind: 'intraday_budget_runaway', day: 4, multiplier: 2.2 }]
  return finish({
    id: 'T23',
    name: 'Катастрофа расхода',
    set: 'tuning',
    days: 14,
    phrases,
    queries,
    ads,
    events,
    cpcByTv,
    expectations: {
      causeCodes: { campaign: 'EMERGENCY_SUSPEND' },
      anomalies: [{ day: 4, kind: 'spend' }],
      notes:
        'День 4 — внутридневная катастрофа: клик дорожает ×2.2 на весь день, дневной расход ' +
        'взрывается при прежнем трафике. Урок EMERGENCY_SUSPEND: предохранитель обязан ' +
        'сработать В ДЕНЬ события по внутридневному расходу, а не после недельного отчёта. ' +
        'Правильная реакция — немедленная остановка/тревога владельцу; «подождать и ' +
        'посмотреть» здесь стоит дороже всего остального прогона.',
    },
  })
}

/** T24. Цикл владельца: спорные запросы без маркеров — только предложением. */
function t24(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  // Четыре жирных спорных (наберут статистику на предложение DISPUTED_MINUS)…
  const fatDisputed = [
    makeDisputedQuery(rng, 0, [keywordIdOf(0), keywordIdOf(1)], true, { share: 0.12, trueCtr: 0.03 }),
    makeDisputedQuery(rng, 6, [keywordIdOf(12), keywordIdOf(13)], true, { share: 0.12, trueCtr: 0.03 }),
    makeDisputedQuery(rng, 15, [keywordIdOf(20), keywordIdOf(21)], true, { share: 0.12, trueCtr: 0.03 }),
    makeDisputedQuery(rng, 18, [keywordIdOf(28), keywordIdOf(29)], true, { share: 0.12, trueCtr: 0.03 }),
  ]
  // …и три тонких: тоже мусор по правде, но данных даже на предложение нет.
  const thinDisputed = [
    makeDisputedQuery(rng, 3, [keywordIdOf(2)], true, { share: 0.015 }),
    makeDisputedQuery(rng, 9, [keywordIdOf(14)], true, { share: 0.015 }),
    makeDisputedQuery(rng, 24, [keywordIdOf(22)], true, { share: 0.015 }),
  ]
  const queries = [
    ...fatDisputed,
    ...thinDisputed,
    makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[2], [keywordIdOf(3)], { share: 0.05 }),
    makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[9], [keywordIdOf(4)], { share: 0.05 }),
  ]
  const ads = makeAds(rng)
  const causeCodes: Record<string, ReasonCode> = {
    [`query:${DISPUTED_QUERY_POOL[0]}`]: 'DISPUTED_MINUS',
    [`query:${DISPUTED_QUERY_POOL[6]}`]: 'DISPUTED_MINUS',
    [`query:${DISPUTED_QUERY_POOL[15]}`]: 'DISPUTED_MINUS',
    [`query:${DISPUTED_QUERY_POOL[18]}`]: 'DISPUTED_MINUS',
  }
  return finish({
    id: 'T24',
    name: 'Цикл владельца: спорные минусы',
    set: 'tuning',
    days: 21,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes,
      anomalies: [],
      notes:
        'Семь запросов без явных маркеров мусора («обеды недорого», «обеды оптом», «доставка ' +
        'обедов дешево»…) с истинной CR = 0. Четыре жирных по доле набирают статистику на ' +
        'предложение DISPUTED_MINUS — Борис вносит их владельцу НА РЕШЕНИЕ, а не минусует ' +
        'сам: маркеров нет, цена ошибки — живой трафик. Три тонких не имеют данных даже на ' +
        'предложение — ждать. Урок: спорное минусуется только через владельца, и право на ' +
        'предложение зарабатывается данными, а не подозрением.',
    },
  })
}

/**
 * T25. Внутри-групповой раскол (Цикл 2.0 — ключевой тест пофразного биддинга).
 * В ОДНОЙ группе G1 живут доказанные конвертеры И «горелки» (клики есть,
 * заявок нет). Групповое усреднение видит группу конвертящей и тащит горелки в
 * дорогой TV75 — прямой слив бюджета (механизм потери M1). Пофразный биддинг
 * судит КАЖДУЮ фразу по её собственной экономике: конвертеры → вход в нижний
 * блок, горелки → минимум. Все фразы — G1 (индексы 0..8), один живой запрос.
 */
function t25(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const conv = [0, 1] // гарантированные конвертеры G1-ядра
  const burners = [5, 6, 7, 8] // «горелки»: объём кликов есть, CR≈0 → заявок нет
  const over: Record<number, Partial<PhraseSpec>> = {}
  for (const pi of conv) {
    over[pi] = {
      trueCr: round4(clamp(jitter(rng, 0.07, 0.1), 0.06, 0.08)),
      demandPerDay: clamp(jitterInt(rng, 80, 0.15), 60, 100),
    }
  }
  for (const pi of burners) {
    over[pi] = {
      trueCr: round4(clamp(jitter(rng, 0.001, 0.5), 0.0003, 0.002)),
      demandPerDay: clamp(jitterInt(rng, 80, 0.15), 60, 100), // объём кликов, чтобы созреть в «горелку»
    }
  }
  const phrases = makePhraseSet(rng, [0, 1, 2, 3, 4, 5, 6, 7, 8], over)
  const queries = [makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[1], [keywordIdOf(0)], { share: 0.05 })]
  const ads = makeAds(rng)
  const causeCodes: Record<string, ReasonCode> = {}
  for (const pi of conv) causeCodes[`keyword:${keywordIdOf(pi)}`] = 'PROVEN_CONVERTER_VOLUME'
  for (const pi of burners) causeCodes[`keyword:${keywordIdOf(pi)}`] = 'TAIL_MIN_TV'
  return finish({
    id: 'T25',
    name: 'Внутри-групповой раскол',
    set: 'tuning',
    days: 21,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes,
      anomalies: [],
      notes:
        'В ОДНОЙ группе G1 — доказанные конвертеры (1001,1002, CR≈0.07) И «горелки» (1006–1009, ' +
        'клики есть, CR≈0). Групповое усреднение видит группу конвертящей и тащит горелки в дорогой ' +
        'TV75 — прямой слив (M1). Урок пофразного экономбиддинга: конвертеры → вход в нижний блок ' +
        '(PROVEN_CONVERTER_VOLUME), горелки → минимум (TAIL_MIN_TV); ставка по КАЖДОЙ фразе из её ' +
        'собственной цены заявки, а не по корзине группы.',
    },
  })
}

/**
 * T26. Инверсия CTR↔CR: «горелка» с ВЫСОКИМ CTR (кликают, но не заявки) и
 * конвертер с НИЗКИМ CTR (кликают мало, но заявки идут). Прямая атака на старую
 * CTR-эвристику ядра (M2): она бы промоутила кликабельную-беззаявочную фразу и
 * морила тихого конвертера. Пофразный ЛИД-сигнал не обманывается кликами.
 */
function t26(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const highCtr = { 15: 0.06, 65: 0.1, 75: 0.13, 85: 0.15, 100: 0.17 }
  const lowCtr = { 15: 0.01, 65: 0.02, 75: 0.03, 85: 0.04, 100: 0.05 }
  const clickyBurner = 6 // высокий CTR, CR≈0
  const quietConverter = 2 // низкий CTR, высокий CR
  const over: Record<number, Partial<PhraseSpec>> = {
    [clickyBurner]: {
      trueCtrByTv: { ...highCtr },
      trueCr: round4(clamp(jitter(rng, 0.001, 0.5), 0.0003, 0.002)),
      demandPerDay: clamp(jitterInt(rng, 80, 0.15), 60, 100),
    },
    [quietConverter]: {
      trueCtrByTv: { ...lowCtr },
      trueCr: round4(clamp(jitter(rng, 0.08, 0.1), 0.07, 0.09)),
      demandPerDay: clamp(jitterInt(rng, 90, 0.15), 70, 110),
    },
  }
  const phrases = makePhraseSet(rng, [0, 1, 2, 3, 4, 5, 6, 7, 8], over)
  const queries = [makeTargetQuery(rng, TARGET_QUERY_VARIATIONS[1], [keywordIdOf(0)], { share: 0.05 })]
  const ads = makeAds(rng)
  return finish({
    id: 'T26',
    name: 'Инверсия CTR и CR',
    set: 'tuning',
    days: 21,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: {
        [`keyword:${keywordIdOf(clickyBurner)}`]: 'TAIL_MIN_TV',
        [`keyword:${keywordIdOf(quietConverter)}`]: 'PROVEN_CONVERTER_VOLUME',
      },
      anomalies: [],
      notes:
        'Горелка 1007 кликабельна (высокий CTR), но CR≈0 — денег не приносит; конвертер 1003 тихий ' +
        '(низкий CTR), но CR≈0.08 — заявки идут. Старая CTR-эвристика ядра промоутила бы 1007 и морила ' +
        '1003. Урок: экономику решает ЛИД-сигнал фразы (TAIL_MIN_TV горелке, PROVEN_CONVERTER_VOLUME ' +
        'конвертеру), а не кликабельность.',
    },
  })
}

// ============================================================
// HOLDOUT: H01–H06
// ============================================================

/** H01. Вариация мусора: другие города и маркеры (срез B), другой джиттер. */
function h01(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  const trash = makeTrashTail(rng, range(15, 29), phrases, {
    shareBase: 0.11,
    sharePct: 0.35,
    sticks: 2,
    maxPerKeyword: 0.4,
  })
  const queries = [...trash, ...standardVariations(rng)]
  const ads = makeAds(rng)
  const causeCodes: Record<string, ReasonCode> = {}
  markTopTrash(queries, 5, causeCodes)
  return finish({
    id: 'H01',
    name: 'Мусор: другие города и маркеры',
    set: 'holdout',
    days: 18,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes,
      anomalies: [],
      notes:
        'Вариация T02 на НЕвиданных маркерах: другие города (волгоград, иркутск, ' +
        'краснодар…), франшиза, «скачать», «реферат», б/у, чужие бренды (обед буфет, яндекс ' +
        'еда), промокоды. Урок тот же — гигиена поискового отчёта, но проверяется ' +
        'ОБОБЩЕНИЕ: правило «чужой город / не наша услуга / халява = мусор», а не ' +
        'зазубренный список слов из тюнинга.',
    },
  })
}

/** H02. Вариация смены режима: другая группа (G1), другой день и лаг (память). */
function h02(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, FULL_36)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  const events: WorldEvent[] = [{ kind: 'regime_change', day: 12, adGroupId: 'G1', newCrMultiplier: 0.2 }]
  return finish({
    id: 'H02',
    name: 'Смена режима: G1, другой лаг',
    set: 'holdout',
    days: 26,
    phrases,
    queries,
    ads,
    events,
    cpcByTv,
    conversionLagDays: { 0: 0.35, 1: 0.3, 2: 0.2, 3: 0.1, 5: 0.05 },
    expectations: {
      causeCodes: { 'adgroup:G1': 'REGIME_CHANGE' },
      anomalies: [{ day: 14, kind: 'leads' }],
      notes:
        '[память] Вариация смены режима: теперь ломается G1 (Офисы) с дня 12 (CR ×0.2), и ' +
        'лаг конверсий немного другой — обвал заявок размазан. Память Бориса из прошлых ' +
        'прогонов («G1 — опора кампании») обязана уступить свежим данным: REGIME_CHANGE по ' +
        'G1. Проверка, что урок T19 усвоен как ПРИНЦИП (режим может сменить любая группа), ' +
        'а не как заученный факт про G2.',
    },
  })
}

/** H03. Вариация CTR-ловушки: слабые тексты теперь у G4. */
function h03(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  const queries = standardVariations(rng)
  const ads = makeAds(rng, { textQualityByGroup: { G4: 0.5 } })
  return finish({
    id: 'H03',
    name: 'CTR-ловушка: тексты в G4',
    set: 'holdout',
    days: 18,
    phrases,
    queries,
    ads,
    cpcByTv,
    expectations: {
      causeCodes: { 'adgroup:G4': 'AD_TEXT_PROBLEM' },
      anomalies: [],
      notes:
        'Вариация CTR-ловушки из тюнинга: слабые тексты теперь у группы G4 (качество ≈0.5). ' +
        'Диагностическая цепочка та же: позиция в норме (ставки и уровни как у всех, видно ' +
        'по странице ставок), охват в норме, а CTR группы вдвое ниже кривой — значит, ' +
        'тексты. Проверка обобщения тройки AD_TEXT_PROBLEM / POSITION_TOO_LOW / ' +
        'LOW_COVERAGE на новой группе, а не заученного «G1 = плохие тексты».',
    },
  })
}

/** H04. НОВЫЙ тип: атака конкурента в выдаче — ловушка поспешного диагноза. */
function h04(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  const events: WorldEvent[] = [{ kind: 'competitor_brand_attack', day: 5, ctrMultiplierCore: 0.55 }]
  return finish({
    id: 'H04',
    name: 'Атака конкурента в выдаче',
    set: 'holdout',
    days: 18,
    phrases,
    queries,
    ads,
    events,
    cpcByTv,
    expectations: {
      causeCodes: { campaign: 'REGIME_CHANGE' },
      anomalies: [{ day: 6, kind: 'ctr' }],
      notes:
        'Ловушка поспешного диагноза: с дня 5 конкурент встаёт в выдачу — CTR ЯДРА разом ' +
        'падает до ×0.55. Похоже на «испортились тексты», но тексты НЕ менялись (качество ' +
        'прежнее, отклонённых объявлений нет) и позиция прежняя — падение синхронное и ' +
        'внешнее. Истинный код — REGIME_CHANGE кампании: мир изменился, прежние ожидания ' +
        'CTR устарели; переписывать объявления вслепую — лечение не той болезни. Тип ' +
        'события в тюнинге не встречался — проверка на новизну, а не на память.',
    },
  })
}

/** H05. НОВЫЙ тип: волна заявок-пустышек — не наградить фразы за спам. */
function h05(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  const phrases = makePhraseSet(rng, MID_24)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  const events: WorldEvent[] = [
    // Дни 6–9: каждый день пачка «заявок» с одним телефоном, без yclid и целей.
    { kind: 'fake_leads_wave', day: 6, days: 4, leadsPerDay: jitterInt(rng, 7, 0.3) },
  ]
  return finish({
    id: 'H05',
    name: 'Волна заявок-пустышек',
    set: 'holdout',
    days: 16,
    phrases,
    queries,
    ads,
    events,
    cpcByTv,
    expectations: {
      causeCodes: { campaign: 'DATA_MISMATCH' },
      anomalies: [{ day: 7, kind: 'mismatch' }],
      notes:
        'Дни 6–9 — волна заявок-пустышек: каждый день приходит пачка «заявок» с ОДНИМ и тем ' +
        'же телефоном, без yclid и без достижений целей в Метрике; расход Директа не растёт. ' +
        'Ловушка — наградить фразы и группы за «рост заявок» и раскрутить ставки. Истина — ' +
        'DATA_MISMATCH: заявки не бьются ни с целями, ни с цепочкой атрибуции; пустышки ' +
        'исключаются из экономики, ставки не трогаются. Борис не должен платить за спам.',
    },
  })
}

/** H06. НОВЫЙ микс: аукцион дорожает И спрос проседает одновременно. */
function h06(rng: Rng): ScenarioConfig {
  const cpcByTv = makeCpcByTv(rng)
  // Ядро держит уровень 75 после дрейфа ×2.35 (ставка ~168 ₽ ≥ цены 129–153 ₽),
  // премиум для него уходит за потолок: 175–205 ₽ × 2.35 = 411–482 ₽ > 400 ₽.
  const over: Record<number, Partial<PhraseSpec>> = {}
  for (const pi of MID_24_CORE) over[pi] = { startBidMicro: jitterInt(rng, 168, 0.03) * 1_000_000 }
  const phrases = makePhraseSet(rng, MID_24, over)
  const queries = standardVariations(rng)
  const ads = makeAds(rng)
  const events: WorldEvent[] = [
    { kind: 'auction_drift', day: 6, priceMultiplier: 2.35 },
    { kind: 'demand_dip', day: 6, days: 6, multiplier: 0.5 },
  ]
  const causeCodes: Record<string, ReasonCode> = { campaign: 'SEASONAL_DIP_HOLD' }
  for (const p of topCoreByDemand(phrases, 2)) causeCodes[`keyword:${p.keywordId}`] = 'AUCTION_ABOVE_CEILING'
  return finish({
    id: 'H06',
    name: 'Двойной удар: аукцион + сезон',
    set: 'holdout',
    days: 21,
    phrases,
    queries,
    ads,
    events,
    cpcByTv,
    expectations: {
      causeCodes,
      anomalies: [
        { day: 7, kind: 'demand' },
        { day: 7, kind: 'cpc' },
      ],
      notes:
        'Двойной удар: с дня 6 одновременно дорожает аукцион (×2.35) и на 6 дней сезонно ' +
        'проседает спрос (×0.5). Задача — РАЗЛОЖИТЬ смесь на причины: падение показов ' +
        'объясняется спросом (SEASONAL_DIP_HOLD — переждать, не резать), а подорожание ' +
        'клика — дрейфом аукциона, из-за которого премиум по топ-ядру теперь дороже потолка ' +
        '400 ₽ (AUCTION_ABOVE_CEILING — держаться нижних уровней). Одно событие не должно ' +
        'маскировать другое; такой комбинации в тюнинге не было.',
    },
  })
}

// ============================================================
// Сборка каталога
// ============================================================

/** Зерно сценария: 32-битное смешение baseSeed и порядкового номера. */
function scenarioSeed(baseSeed: number, ordinal: number): number {
  const mixed = Math.imul(baseSeed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(ordinal + 1, 0xc2b2ae35)
  return mixed >>> 0
}

/**
 * Полный каталог: 24 tuning + 6 holdout. Детерминирован по baseSeed:
 * buildCatalog(s) при равном s байт-в-байт одинаков между вызовами.
 */
export function buildCatalog(baseSeed: number): ScenarioConfig[] {
  const builders: Array<(rng: Rng) => ScenarioConfig> = [
    t01, t02, t03, t04, t05, t06, t07, t08, t09, t10, t11, t12,
    t13, t14, t15, t16, t17, t18, t19, t20, t21, t22, t23, t24,
    t25, t26,
    h01, h02, h03, h04, h05, h06,
  ]
  return builders.map((build, ordinal) => build(mulberry32(scenarioSeed(baseSeed, ordinal))))
}
