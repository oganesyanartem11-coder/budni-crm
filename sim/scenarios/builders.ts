/**
 * ФАБРИКИ КАТАЛОГА СЦЕНАРИЕВ полигона Бориса-Директа.
 *
 * Зачем пулы: LLM-кеш полигона живёт на уникальных текстах, поэтому тексты
 * фраз и запросов берутся из ОГРАНИЧЕННЫХ пулов и переиспользуются между
 * сценариями. Никаких генераций тысяч уникальных строк.
 *
 * Детерминизм: вся случайность — ТОЛЬКО из переданного rng: () => number
 * (mulberry32 от зерна каталога). Math.random и Date запрещены. Порядок
 * draw'ов внутри каждой фабрики фиксирован — не менять, иначе поплывут
 * все сценарии, собранные после точки изменения.
 *
 * Масштаб калибровки — реальная кампания «обеды в офис/на объект» (Москва+МО,
 * B2B): 4 группы, 20–40 фраз, дневной бюджет ~3000 ₽, CPC входа в 65-й уровень
 * ~45 ₽, премиум-уровни в 3–4 раза дороже.
 */

import type { AdSpec, PhraseSpec, QuerySpec, TargetQuerySpec, TrashQuerySpec } from '../types'

export type Rng = () => number

// ============================================================
// RNG и числовые хелперы
// ============================================================

/** mulberry32 — быстрый детерминированный PRNG (тот же алгоритм, что в движке мира). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Джиттер значения на ±pct (pct = 0.1 → ±10%). Ровно один draw из rng. */
export function jitter(rng: Rng, value: number, pct: number): number {
  return value * (1 + (rng() * 2 - 1) * pct)
}

/** Целочисленный джиттер. */
export function jitterInt(rng: Rng, value: number, pct: number): number {
  return Math.round(jitter(rng, value, pct))
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

/** Округление до 4 знаков — конфиги читаемые и стабильные при сравнении. */
export function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

// ============================================================
// Группы и базовые константы калибровки
// ============================================================

/** Четыре группы реальной кампании (id — строками, как в Директе). */
export const GROUPS = [
  { id: 'G1', name: 'Офисы' },
  { id: 'G2', name: 'Стройки' },
  { id: 'G8', name: 'Склады' },
  { id: 'G4', name: 'Мероприятия' },
] as const

/** Уровни бинарной шкалы TrafficVolume. */
export const TV_LEVELS = [15, 65, 75, 85, 100] as const

/** Базовая цена клика по уровням, руб (премиум ×3–4 от входа — как в жизни). */
export const BASE_CPC_BY_TV: Record<number, number> = { 15: 25, 65: 45, 75: 60, 85: 190, 100: 260 }

/** Базовый истинный CTR по уровням (растёт с уровнем). */
export const BASE_CTR_BY_TV: Record<number, number> = { 15: 0.02, 65: 0.05, 75: 0.07, 85: 0.09, 100: 0.11 }

/** Недельная сезонность B2B-обедов: будни ровные, пятница чуть тише, выходные мёртвые. */
export const BASE_WEEKDAY_DEMAND = [1, 1, 1, 1, 0.9, 0.15, 0.1] as const

/** Базовый лаг конверсии (день клика → день заявки), сумма = 1. */
export const BASE_CONVERSION_LAG: Record<number, number> = { 0: 0.5, 1: 0.25, 2: 0.15, 3: 0.07, 5: 0.03 }

/** Базовая доля заявок с потерянным yclid (грязь атрибуции реального мира). */
export const BASE_YCLID_LOSS = 0.1

// ============================================================
// ПУЛ ЦЕЛЕВЫХ ФРАЗ (40) — переиспользуется всеми сценариями.
// keywordId фразы стабилен: 1001 + индекс пула (важно для LLM-кеша
// и для ссылок 'keyword:NNNN' в expectations).
// ============================================================

interface PoolPhrase {
  text: string
  /** Индекс группы в GROUPS. */
  group: 0 | 1 | 2 | 3
  core: boolean
}

export const TARGET_PHRASE_POOL: readonly PoolPhrase[] = [
  // --- G1 Офисы (индексы 0..11) ---
  { text: 'доставка обедов в офис', group: 0, core: true }, // 1001
  { text: 'корпоративное питание для сотрудников', group: 0, core: true }, // 1002
  { text: 'доставка готовых обедов в офис москва', group: 0, core: true }, // 1003
  { text: 'обеды в офис с доставкой', group: 0, core: true }, // 1004
  { text: 'комплексные обеды в офис', group: 0, core: true }, // 1005
  { text: 'доставка бизнес ланчей в офис', group: 0, core: false }, // 1006
  { text: 'горячие обеды в офис для сотрудников', group: 0, core: false }, // 1007
  { text: 'корпоративные обеды с доставкой москва', group: 0, core: false }, // 1008
  { text: 'доставка еды в офис для компании', group: 0, core: false }, // 1009
  { text: 'организация питания сотрудников в офисе', group: 0, core: false }, // 1010
  { text: 'доставка обедов в офис недорого', group: 0, core: false }, // 1011
  { text: 'еженедельная доставка обедов в офис', group: 0, core: false }, // 1012
  // --- G2 Стройки (индексы 12..19) ---
  { text: 'обеды на стройку с доставкой', group: 1, core: true }, // 1013
  { text: 'доставка питания на строительный объект', group: 1, core: true }, // 1014
  { text: 'горячее питание для рабочих на объекте', group: 1, core: true }, // 1015
  { text: 'доставка обедов для строительной бригады', group: 1, core: false }, // 1016
  { text: 'комплексные обеды на стройплощадку', group: 1, core: false }, // 1017
  { text: 'питание рабочих на стройке москва', group: 1, core: false }, // 1018
  { text: 'доставка горячих обедов на объект мо', group: 1, core: false }, // 1019
  { text: 'обеды для вахтовых рабочих с доставкой', group: 1, core: false }, // 1020
  // --- G8 Склады (индексы 20..27) ---
  { text: 'доставка обедов на склад', group: 2, core: true }, // 1021
  { text: 'питание для сотрудников склада', group: 2, core: true }, // 1022
  { text: 'доставка горячего питания на производство', group: 2, core: true }, // 1023
  { text: 'обеды для персонала склада москва', group: 2, core: false }, // 1024
  { text: 'корпоративное питание на складе', group: 2, core: false }, // 1025
  { text: 'доставка обедов на производство подмосковье', group: 2, core: false }, // 1026
  { text: 'комплексные обеды для рабочих склада', group: 2, core: false }, // 1027
  { text: 'доставка питания в распределительный центр', group: 2, core: false }, // 1028
  // --- G4 Мероприятия (индексы 28..35) ---
  { text: 'доставка обедов на мероприятие', group: 3, core: true }, // 1029
  { text: 'питание участников мероприятия', group: 3, core: true }, // 1030
  { text: 'кейтеринг для делового мероприятия', group: 3, core: false }, // 1031
  { text: 'доставка ланч боксов на конференцию', group: 3, core: true }, // 1032
  { text: 'обеды для семинара с доставкой', group: 3, core: false }, // 1033
  { text: 'горячие обеды на выездное мероприятие', group: 3, core: false }, // 1034
  { text: 'ланч боксы для форума москва', group: 3, core: false }, // 1035
  { text: 'питание для съемочной группы доставка', group: 3, core: false }, // 1036
  // --- добор по группам (индексы 36..39) ---
  { text: 'обеды в офис от 10 человек', group: 0, core: false }, // 1037
  { text: 'доставка обедов на стройку подмосковье', group: 1, core: false }, // 1038
  { text: 'обеды на склад ночная смена', group: 2, core: false }, // 1039
  { text: 'кофе брейк и обеды на мероприятие', group: 3, core: false }, // 1040
]

/** Стабильный KeywordId по индексу пула. */
export function keywordIdOf(poolIndex: number): number {
  return 1001 + poolIndex
}

// ============================================================
// ПУЛ МУСОРНЫХ ЗАПРОСОВ (50) — с ЯВНЫМИ маркерами мусора.
// Срез A (0..14) — города-1/бесплатно/рецепты/вакансии — тюнинг (T02).
// Срез B (15..29) — города-2/франшиза/б-у/чужие бренды — holdout (H01).
// Срез C (30..49) — прочие маркеры — миксы и спецсценарии.
// ============================================================

export const TRASH_QUERY_POOL: readonly string[] = [
  // --- срез A (0..14) ---
  'доставка обедов в офис казань', // 0: город вне МО
  'доставка обедов екатеринбург', // 1: город вне МО
  'обеды в офис спб', // 2: город вне МО
  'корпоративное питание новосибирск', // 3: город вне МО
  'доставка обедов самара', // 4: город вне МО
  'доставка обедов в офис бесплатно', // 5: «бесплатно»
  'бесплатные обеды для сотрудников', // 6: «бесплатно»
  'рецепт комплексного обеда', // 7: «рецепт»
  'рецепты обедов на неделю для семьи', // 8: «рецепт», b2c
  'обеды в офис своими руками', // 9: «своими руками»
  'вакансии повара корпоративное питание', // 10: «вакансии»
  'работа курьером доставка обедов', // 11: «работа»-вакансия
  'курсовая организация питания сотрудников', // 12: «курсовая»
  'б/у термосы для доставки еды', // 13: «б/у», товар
  'кухня на районе обеды в офис', // 14: чужой бренд
  // --- срез B (15..29) ---
  'доставка обедов волгоград', // 15: город вне МО
  'обеды на стройку иркутск', // 16: город вне МО
  'корпоративное питание краснодар', // 17: город вне МО
  'доставка обедов нижний новгород', // 18: город вне МО
  'комплексные обеды челябинск', // 19: город вне МО
  'франшиза доставки обедов', // 20: франшиза, не клиент
  'бизнес план доставки обедов скачать', // 21: «скачать», не клиент
  'реферат организация корпоративного питания', // 22: «реферат»
  'б/у оборудование для столовой', // 23: «б/у», товар
  'обед буфет доставка обедов', // 24: чужой бренд
  'яндекс еда обеды в офис', // 25: чужой бренд
  'промокод на доставку обедов', // 26: «промокод», халява
  'столовая рядом со мной недорого', // 27: b2c-оффлайн
  'шаурма с доставкой круглосуточно', // 28: не наша услуга
  'доставка продуктов на дом москва', // 29: продукты, не обеды
  // --- срез C (30..49) ---
  'доставка обедов ростов на дону', // 30: город вне МО
  'обеды с доставкой уфа', // 31: город вне МО
  'доставка питания пермь', // 32: город вне МО
  'корпоративные обеды воронеж', // 33: город вне МО
  'доставка обедов тюмень', // 34: город вне МО
  'вакансии кухонный работник москва', // 35: «вакансии»
  'работа поваром на стройке вахтой', // 36: «работа»-вакансия
  'доставка обедов работа', // 37: T20 — ловушка однословного минуса «работа»
  'скачать презентацию корпоративное питание', // 38: «скачать»
  'диетические обеды для похудения с доставкой', // 39: b2c-похудение
  'готовые рационы для похудения заказать', // 40: b2c-похудение
  'детские обеды в школу с доставкой', // 41: не b2b
  'доставка обедов на дом пенсионерам', // 42: соцуслуга, не b2b
  'одноразовая посуда для обедов оптом', // 43: товар, не услуга
  'контейнеры для ланч боксов оптом', // 44: товар, не услуга
  'деливери клаб обеды в офис', // 45: чужой бренд
  'обеды в офис минск', // 46: вне РФ
  'дипломная работа питание рабочих', // 47: «дипломная»
  'своими руками ланч бокс на работу', // 48: «своими руками»
  'кейтеринг спб недорого', // 49: город вне МО
]

// ============================================================
// ПУЛ СПОРНЫХ ЗАПРОСОВ (30) — БЕЗ явных маркеров: могут оказаться
// и мусором, и целью. Истину назначает сценарий (asTrash).
// ============================================================

export const DISPUTED_QUERY_POOL: readonly string[] = [
  'обеды недорого', // 0
  'еда в офис отзывы', // 1
  'доставка питания для коллектива цена', // 2
  'обеды с доставкой цена', // 3
  'доставка еды на работу', // 4
  'еда для сотрудников', // 5
  'обеды оптом', // 6
  'доставка обедов отзывы', // 7
  'комплексный обед стоимость', // 8
  'питание для персонала варианты', // 9
  'сколько стоит обед для сотрудников', // 10
  'еда на объект', // 11
  'доставка еды юридическим лицам', // 12
  'обеды по договору', // 13
  'еда в термосах доставка', // 14
  'доставка обедов дешево', // 15
  'обеды для водителей', // 16
  'питание смены на производстве', // 17
  'где заказать обеды для персонала', // 18
  'обеды навынос для компании', // 19
  'доставка комплексных обедов поблизости', // 20
  'еда на неделю для офиса', // 21
  'обеды для небольшой компании', // 22
  'горячее питание цена за порцию', // 23
  'доставка обедов ежедневно', // 24
  'обеды с доставкой на завтра', // 25
  'еда для команды на смену', // 26
  'доставка обедов для ип', // 27
  'обеды корпоративным клиентам условия', // 28
  'питание сотрудников аутсорсинг', // 29
]

// ============================================================
// ПУЛ ЖИВЫХ ЗАПРОСОВ-ВАРИАЦИЙ (10) — целевой трафик, минусовать НЕЛЬЗЯ.
// ============================================================

export const TARGET_QUERY_VARIATIONS: readonly string[] = [
  'доставка обедов на работу', // 0: T20 — живой «близнец» мусорного «доставка обедов работа»
  'заказать обеды в офис на неделю', // 1
  'доставка горячих обедов в офис москва', // 2
  'обеды для сотрудников с доставкой в офис', // 3
  'доставка обедов на строительный объект московская область', // 4
  'питание для рабочих с доставкой на объект', // 5
  'обеды с доставкой на склад москва', // 6
  'корпоративное питание с доставкой для офиса', // 7
  'ланч боксы на мероприятие с доставкой', // 8
  'доставка комплексных обедов юридическим лицам', // 9
]

// ============================================================
// Фабрики
// ============================================================

/**
 * Истинный CTR по уровням TV: базовая кривая × общий множитель фразы
 * × лёгкий пошумливающий джиттер (±5%). Монотонность по уровням сохраняется
 * конструктивно: множитель общий, а зазоры базовой кривой больше джиттера.
 */
export function makeCtrByTv(rng: Rng, mult = 1): Record<number, number> {
  const out: Record<number, number> = {}
  for (const tv of TV_LEVELS) {
    out[tv] = round4(clamp(jitter(rng, BASE_CTR_BY_TV[tv] * mult, 0.05), 0.003, 0.35))
  }
  return out
}

/** Цена клика по уровням с джиттером ±8%; возрастание уровней гарантируется. */
export function makeCpcByTv(rng: Rng, base: Record<number, number> = BASE_CPC_BY_TV): Record<number, number> {
  const out: Record<number, number> = {}
  let prev = 0
  for (const tv of TV_LEVELS) {
    const v = Math.max(prev + 1, jitterInt(rng, base[tv], 0.08))
    out[tv] = v
    prev = v
  }
  return out
}

/**
 * Фраза из пула. Порядок draw'ов фиксирован: множитель CTR → 5 уровней CTR →
 * CR → спрос → ставка. overrides применяются ПОСЛЕ draw'ов, поэтому не
 * сдвигают поток случайности (сценарии с одинаковым набором индексов
 * остаются сравнимыми).
 *
 * Калибровка: trueCr целевых 0.02–0.08 (ядро выше хвоста), demandPerDay
 * ядро ~40–90, хвост ~20–40.
 *
 * СТАРТОВАЯ СТАВКА — по ЖИВОМУ ФАКТУ A (keywordbids.get 12.07, 194 ключа): в реальном
 * портфеле ~28% фраз стоят НИЖЕ входа (медиана −13%, фактически на рунге TV15), 72% —
 * на входе (TV65). Прежняя калибровка стартовала ВСЕ на входе (~52 ₽ → TV65), из-за чего
 * бездействие было бесплатным, а любой ввод хвоста — только оверштотом. Теперь мир стартует
 * с реалистичным хвостом ниже входа: удержание ниже-входа стоит показов/объёма (мир уже это
 * моделирует: показы ∝ tv/75), а ввод конвертера с рунга TV15 на вход РЕАЛЬНО захватывает
 * объём. Один rng()-дро (как прежний jitterInt) — поток случайности НЕ сдвигается; оракул
 * optimalTv (levelEconomics, не зависит от старта) НЕ меняется, скорер/гейт НЕ трогаются.
 */
const BELOW_ENTRY_SHARE = 0.28 // ФАКТ A: доля портфеля ниже входа
export function makePhrase(rng: Rng, poolIndex: number, overrides: Partial<PhraseSpec> = {}): PhraseSpec {
  const spec = TARGET_PHRASE_POOL[poolIndex]
  if (!spec) throw new Error(`Нет фразы в пуле: индекс ${poolIndex}`)
  const g = GROUPS[spec.group]
  const ctrMult = jitter(rng, spec.core ? 1.15 : 0.85, 0.08)
  const trueCtrByTv = makeCtrByTv(rng, ctrMult)
  const trueCr = spec.core
    ? round4(clamp(jitter(rng, 0.055, 0.35), 0.03, 0.08))
    : round4(clamp(jitter(rng, 0.032, 0.4), 0.02, 0.05))
  const demandPerDay = spec.core
    ? clamp(jitterInt(rng, 70, 0.3), 40, 200)
    : clamp(jitterInt(rng, 30, 0.3), 20, 90)
  // ФАКТ A: 28% ниже входа (bid 30–42 ₽ → TV15, cpc15≈25 ≤ bid < cpc65≈45); 72% на входе
  // (46–58 ₽ → TV65). Тот же ОДИН rng()-дро, что и прежний jitterInt (поток не сдвинут).
  const u = rng()
  const startBidMicro =
    (u < BELOW_ENTRY_SHARE
      ? Math.round(30 + (u / BELOW_ENTRY_SHARE) * 12)
      : Math.round(46 + ((u - BELOW_ENTRY_SHARE) / (1 - BELOW_ENTRY_SHARE)) * 12)) * 1_000_000
  return {
    keywordId: keywordIdOf(poolIndex),
    adGroupId: g.id,
    adGroupName: g.name,
    text: spec.text,
    isCore: spec.core,
    trueCtrByTv,
    trueCr,
    demandPerDay,
    startBidMicro,
    ...overrides,
  }
}

/** Набор фраз по индексам пула; overrides — по индексу пула. */
export function makePhraseSet(
  rng: Rng,
  poolIndexes: number[],
  overrides: Record<number, Partial<PhraseSpec>> = {}
): PhraseSpec[] {
  return poolIndexes.map((pi) => makePhrase(rng, pi, overrides[pi]))
}

/** Мусорный запрос из пула: CTR низкий, CR = 0, доля показов маленькая. */
export function makeTrashQuery(
  rng: Rng,
  poolIndex: number,
  sticksTo: number[],
  overrides: Partial<TrashQuerySpec> = {}
): TrashQuerySpec {
  const query = TRASH_QUERY_POOL[poolIndex]
  if (!query) throw new Error(`Нет мусорного запроса в пуле: индекс ${poolIndex}`)
  const trueCtr = round4(clamp(jitter(rng, 0.012, 0.4), 0.004, 0.03))
  const share = round4(clamp(jitter(rng, 0.05, 0.4), 0.005, 0.25))
  return { query, sticksTo, share, trueCtr, trueCr: 0, isTrash: true, ...overrides }
}

/** Живой запрос-вариация: конвертит, минусовать нельзя. Текст — из пула вариаций. */
export function makeTargetQuery(
  rng: Rng,
  text: string,
  sticksTo: number[],
  overrides: Partial<TargetQuerySpec> = {}
): TargetQuerySpec {
  const trueCtr = round4(clamp(jitter(rng, 0.06, 0.25), 0.02, 0.12))
  const trueCr = round4(clamp(jitter(rng, 0.045, 0.3), 0.02, 0.08))
  const share = round4(clamp(jitter(rng, 0.04, 0.4), 0.01, 0.1))
  return { query: text, sticksTo, share, trueCtr, trueCr, isTrash: false, ...overrides }
}

/**
 * Спорный запрос БЕЗ маркеров: сценарий назначает истину (asTrash).
 * Кол-во draw'ов одинаково в обеих ветках — поток rng стабилен.
 */
export function makeDisputedQuery(
  rng: Rng,
  poolIndex: number,
  sticksTo: number[],
  asTrash: boolean,
  overrides: { share?: number; trueCtr?: number; trueCr?: number } = {}
): QuerySpec {
  const query = DISPUTED_QUERY_POOL[poolIndex]
  if (!query) throw new Error(`Нет спорного запроса в пуле: индекс ${poolIndex}`)
  const ctrDraw = jitter(rng, asTrash ? 0.02 : 0.035, 0.3)
  const crDraw = jitter(rng, 0.03, 0.3) // draw делается всегда, даже для мусора
  const share = round4(clamp(jitter(rng, 0.035, 0.35), 0.01, 0.08))
  if (asTrash) {
    return {
      query,
      sticksTo,
      share: overrides.share ?? share,
      trueCtr: overrides.trueCtr ?? round4(clamp(ctrDraw, 0.008, 0.04)),
      trueCr: 0,
      isTrash: true,
    }
  }
  return {
    query,
    sticksTo,
    share: overrides.share ?? share,
    trueCtr: overrides.trueCtr ?? round4(clamp(ctrDraw, 0.015, 0.06)),
    trueCr: overrides.trueCr ?? round4(clamp(crDraw, 0.02, 0.06)),
    isTrash: false,
  }
}

/**
 * Мусорный хвост: раскладывает запросы пула по фразам (каждый липнет к
 * 1–3 фразам), следя, чтобы суммарная доля мусора на фразу не превысила
 * maxPerKeyword (страж инварианта «сумма share на фразу ≤ 0.6»).
 */
export function makeTrashTail(
  rng: Rng,
  poolIndexes: number[],
  phrases: PhraseSpec[],
  opts: { shareBase?: number; sharePct?: number; sticks?: number; maxPerKeyword?: number } = {}
): TrashQuerySpec[] {
  const { shareBase = 0.03, sharePct = 0.3, sticks = 2, maxPerKeyword = 0.45 } = opts
  const sums = new Map<number, number>()
  const out: TrashQuerySpec[] = []
  for (const pi of poolIndexes) {
    const share = round4(clamp(jitter(rng, shareBase, sharePct), 0.005, 0.25))
    const chosen: number[] = []
    for (let s = 0; s < sticks; s++) {
      const start = Math.floor(rng() * phrases.length)
      // идём по кругу от выпавшего индекса — первый кандидат с запасом доли
      for (let hop = 0; hop < phrases.length; hop++) {
        const cand = phrases[(start + hop) % phrases.length].keywordId
        if (chosen.includes(cand)) continue
        if ((sums.get(cand) ?? 0) + share > maxPerKeyword) continue
        chosen.push(cand)
        break
      }
    }
    if (chosen.length === 0) continue // некуда липнуть без нарушения инварианта — пропускаем
    for (const k of chosen) sums.set(k, (sums.get(k) ?? 0) + share)
    out.push(makeTrashQuery(rng, pi, chosen, { share }))
  }
  return out
}

/**
 * Объявления: по perGroup на каждую из 4 групп. textQuality ≈ 1 (норма)
 * либо целевое значение по группе (сценарии AD_TEXT_PROBLEM задают 0.45–0.5).
 */
export function makeAds(
  rng: Rng,
  opts: {
    perGroup?: number
    textQualityByGroup?: Record<string, number>
    rejectedFromDayByGroup?: Record<string, number>
  } = {}
): AdSpec[] {
  const perGroup = opts.perGroup ?? 2
  const out: AdSpec[] = []
  GROUPS.forEach((g, gi) => {
    for (let n = 0; n < perGroup; n++) {
      const target = opts.textQualityByGroup?.[g.id] ?? 1
      out.push({
        adId: 5001 + gi * 10 + n,
        adGroupId: g.id,
        textQuality: round4(clamp(jitter(rng, target, 0.05), 0.3, 1.15)),
        rejectedFromDay: opts.rejectedFromDayByGroup?.[g.id] ?? null,
      })
    }
  })
  return out
}
