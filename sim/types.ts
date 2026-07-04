/**
 * ПОЛИГОН БОРИСА-ДИРЕКТА — контракты (закон для всех зон полигона).
 *
 * Здесь ВСЕ типы, через которые общаются: движок мира (engine/), фейки
 * транспорта (fakes/), оракул и боты (oracle/, policies/), скорер (score/),
 * каталог сценариев (scenarios/) и раннер (runner/).
 *
 * ЖЕЛЕЗНОЕ ПРАВИЛО: правда мира (WorldTruth, поля true*) доступна ТОЛЬКО
 * оракулу, скореру и владельцу-боту. В фейки транспорта отдаются только
 * наблюдаемые проекции (Observables). Код src/lib/boris-direct/ НИКОГДА
 * не импортирует ничего из sim/ — это стережёт страж-тест.
 *
 * Деньги: как в бою — ставки в МИКРОЕДИНИЦАХ (×10^6), расходы в рублях.
 * Время: виртуальные дни, day 0 = понедельник. МСК-календарь.
 */

// ============================================================
// Коды причин (зеркало src/lib/boris-direct/reason-codes.ts).
// Скорер сравнивает код Бориса с истинным кодом ситуации.
// ============================================================

export type ReasonCode =
  | 'DATA_NO_CONV' // показы/расход без конверсий за период
  | 'STRUCTURAL_TRASH' // структурный мусор (чужой бренд, вне гео, не наша услуга)
  | 'DISPUTED_MINUS' // спорный минус — предложением владельцу
  | 'PROVEN_CONVERTER_VOLUME' // доказанный конвертер — дать объём (TV75)
  | 'CORE_LOWER_BLOCK' // ядро — вход в нижний блок (TV>=55)
  | 'TAIL_MIN_TV' // хвост — минимальный уровень (TV15)
  | 'AUCTION_ABOVE_CEILING' // вход дороже потолка 400 ₽ — держаться
  | 'QUARANTINE_HOLD' // карантин — наблюдать
  | 'NOISE_HOLD' // статистический шум — не действовать
  | 'SEASONAL_DIP_HOLD' // сезонный/недельный провал — не паниковать
  | 'AD_TEXT_PROBLEM' // CTR низкий при нормальной позиции — вопрос к тексту
  | 'POSITION_TOO_LOW' // позиция низкая — вопрос к ставке
  | 'LOW_COVERAGE' // мало показов — охват/ждать
  | 'FORM_DROPOFF' // визиты качественные, отвал на форме — оффер/форма
  | 'BOT_TRAFFIC' // клики без визитов/мгновенные отказы — бот
  | 'DATA_MISMATCH' // источники противоречат — зафлагать
  | 'SCHEDULE_WASTE' // расход в мёртвые часы/дни (нет расписания, выходные/ночь)
  | 'DEVICE_SKEW' // конверсия по устройствам перекошена, корректировки нет
  | 'AUDIENCE_WASTE' // расход на нецелевую демографию без корректировки
  | 'GROUP_MINUS_GAP' // минус кампании каннибалит конвертящий запрос группы
  | 'REGIME_CHANGE' // мир изменился — прежний вывод устарел
  | 'EXPLORATION' // разведка недооткрученного
  | 'CIRCUIT_BREAKER' // предохранитель: пачка вне паттерна
  | 'EMERGENCY_SUSPEND' // катастрофа расхода
  | 'ANOMALY_ALERT' // прочая аномалия

// ============================================================
// Сценарий (конфиг мира)
// ============================================================

export type ScenarioSet = 'tuning' | 'holdout'

export interface PhraseSpec {
  /** Числовой id ключевой фразы (как KeywordId Директа). */
  keywordId: number
  adGroupId: string
  adGroupName: string
  text: string
  isCore: boolean
  /**
   * Истинный CTR по уровням TrafficVolume (доля кликов от показов на уровне).
   * Ключи — уровни бинарной шкалы: 15 | 65 | 75 | 85 | 100.
   */
  trueCtrByTv: Record<number, number>
  /** Истинная конверсия клика в заявку (0..1). Скрыта от Бориса. */
  trueCr: number
  /** Базовый спрос: средние показы/день на уровне TV75 в будни. */
  demandPerDay: number
  /** Стартовая ставка, микроединицы. */
  startBidMicro: number
}

/** Пул мусорных запросов, липнущих к фразе (широкое соответствие). */
export interface TrashQuerySpec {
  /** Текст мусорного запроса (маркеры: город вне МО, «бесплатно», чужой бренд...). */
  query: string
  /** К каким фразам липнет (keywordId[]). */
  sticksTo: number[]
  /** Доля показов фразы, которую отъедает мусор (0..1). */
  share: number
  /** Истинный CTR мусора (обычно ниже) и конверсия (обычно 0). */
  trueCtr: number
  trueCr: number
  /** Истинная метка: это мусор, который НАДО минусовать. */
  isTrash: true
}

/** Целевой запрос-вариация (минусовать НЕЛЬЗЯ — живой трафик). */
export interface TargetQuerySpec {
  query: string
  sticksTo: number[]
  share: number
  trueCtr: number
  trueCr: number
  isTrash: false
}

export type QuerySpec = TrashQuerySpec | TargetQuerySpec

export interface AdSpec {
  adId: number
  adGroupId: string
  /** Истинное качество текста (множитель CTR, 1 = норма, 0.5 = плохой текст). */
  textQuality: number
  /** REJECTED с какого дня (null = не отклонено). */
  rejectedFromDay: number | null
}

/** Событие мира по расписанию сценария. */
export type WorldEvent =
  | { kind: 'form_break'; day: number } // форма ломается: визиты живут, заявки в ноль
  | { kind: 'form_fix'; day: number }
  | { kind: 'regime_change'; day: number; adGroupId: string; newCrMultiplier: number } // группа сменила экономику
  | { kind: 'auction_drift'; day: number; priceMultiplier: number } // аукцион дорожает/дешевеет
  | { kind: 'demand_dip'; day: number; days: number; multiplier: number } // сезонный провал
  | { kind: 'bot_wave'; day: number; days: number; keywordIds: number[]; clicksPerDay: number } // бот-клики без визитов
  | { kind: 'fake_leads_wave'; day: number; days: number; leadsPerDay: number } // заявки-пустышки (дубли телефонов, без yclid-цепочки)
  | { kind: 'metrica_tag_off'; day: number } // разметка слетела: yclid у новых заявок теряется
  | { kind: 'competitor_brand_attack'; day: number; ctrMultiplierCore: number } // конкурент в выдаче: CTR ядра падает
  | { kind: 'intraday_budget_runaway'; day: number; multiplier: number } // катастрофа расхода внутри дня

export interface ScenarioExpectations {
  /** Истинные коды причин ключевых ситуаций сценария: subjectId → код. */
  causeCodes: Record<string, ReasonCode>
  /** Истинные аномалии: какого дня и какого рода их ОБЯЗАН заметить идеальный аналитик. */
  anomalies: Array<{ day: number; kind: string }>
  /** Комментарий автора сценария (в отчёт разбора ошибок). */
  notes: string
}

export interface ScenarioConfig {
  id: string
  name: string
  set: ScenarioSet
  days: number // длина симуляции в виртуальных днях (day 0 = понедельник)
  quarantineUntilDay: number // до какого дня кампания «молодая» (0 = не в карантине)
  phrases: PhraseSpec[]
  queries: QuerySpec[]
  ads: AdSpec[]
  events: WorldEvent[]
  /** Недельная сезонность спроса: множители по дню недели, [пн..вс], б2б-обеды: выходные ~0.1. */
  weekdayDemand: [number, number, number, number, number, number, number]
  /** Лаг конверсии: распределение задержки заявки после клика, дни → вероятность (сумма=1). */
  conversionLagDays: Record<number, number>
  /** Доля заявок, теряющих yclid (грязь атрибуции реального мира). */
  yclidLossRate: number
  /** Цена клика уровня TV по умолчанию, руб: {15: .., 65: .., 75: .., 85: .., 100: ..}. */
  cpcByTv: Record<number, number>
  expectations: ScenarioExpectations
  /**
   * Разведочные сигналы под диагнозы сессии «Прозрение» (ШАГ 3 «догнать полигон»).
   * НЕОБЯЗАТЕЛЬНО — у всех существующих сценариев отсутствует, поэтому диагнозы
   * DEVICE_SKEW/SCHEDULE_WASTE в базовой линейке молчат (baseline не меняется).
   * Фейки транспорта читают это из world.internal.
   */
  diagnostics?: {
    /** Инъекция device-среза Метрики: зажигает DEVICE_SKEW (перекос устройств). */
    deviceStats?: Array<{ device: string; visits: number; goalReaches: number; bounceRate: number }>
    /** true → у кампании НЕТ расписания показов (зажигает SCHEDULE_WASTE). */
    noSchedule?: boolean
  }
}

// ============================================================
// Мир (движок). Правда — только оракулу/скореру/владельцу-боту.
// ============================================================

/** Событие «клик» в правде мира — из него растут визит и заявка. */
export interface TruthClick {
  day: number
  keywordId: number
  adGroupId: string
  query: string
  isTrashQuery: boolean
  yclid: string | null // null = потерян (yclidLossRate / tag_off)
  costRub: number
  /** Свойства визита Метрики (null = визита не было, бот/потеря). */
  visit: { depthPages: number; durationSec: number; reachedForm: boolean; bounced: boolean } | null
  /** Заявка: день материализации (клик-день + лаг) или null. */
  leadDay: number | null
  /** Пустышка? (fake_leads_wave: телефон-дубль, не настоящий спрос). */
  leadIsFake: boolean
}

export interface WorldState {
  readonly config: ScenarioConfig
  readonly seed: number
  /** Текущий виртуальный день (0-based). */
  day: number
  /** Текущие ставки, микроединицы (мутируются политиками через фейк-клиент). */
  bidsMicro: Map<number, number>
  /** Текущий список минус-фраз кампании (КАМПЕЙН-ЛЕВЕЛ: бьёт по всем группам). */
  negatives: string[]
  campaignSuspended: boolean
  keywordsSuspended: Set<number>
  addMetricaTag: 'YES' | 'NO'
  /** Полная правда всех кликов по дням (растёт по ходу симуляции). */
  truthClicks: TruthClick[]
  /** Служебное состояние генератора (RNG и пр.) — движок знает сам. */
  internal: unknown
}

/** Наблюдаемая строка поискового отчёта за день (проекция правды). */
export interface ObservedQueryRow {
  day: number
  query: string
  adGroupId: string
  adGroupName: string
  impressions: number
  clicks: number
  costRub: number
  /** Конверсии по цели за день клика — как их отдаёт Директ (по факту достижения цели). */
  conversions: number
}

export interface ObservedKeywordBid {
  keywordId: number
  adGroupId: string
  bidMicro: number
  /** Аукцион на сегодня: [{tv, bidMicro, priceMicro}] по бинарной шкале. */
  auction: Array<{ tv: number; bidMicro: number; priceMicro: number }>
}

export interface ObservedMetrikaDay {
  day: number
  visits: number
  goalReaches: number
  bounceRate: number
  avgDepth: number
  /** Доля визитов, дошедших до формы (важнейший сигнал FORM_DROPOFF). */
  formReachRate: number
}

export interface ObservedLead {
  day: number
  phoneDigits: string
  yclid: string | null
  utmCampaign: string | null
  utmTerm: string | null
}

/** Всё, что мир отдаёт фейкам транспорта за день. БЕЗ правды. */
export interface DayObservables {
  day: number
  queryRows: ObservedQueryRow[]
  keywordBids: ObservedKeywordBid[]
  metrika: ObservedMetrikaDay
  metrikaByUtm: Array<{ utmTerm: string; visits: number; goalReaches: number }>
  newLeads: ObservedLead[]
  spentTodayRub: number
  impressionsToday: number
  rejectedAdsCount: number
  addMetricaTag: 'YES' | 'NO'
}

// ============================================================
// Политики (Борис и боты) и захват действий
// ============================================================

export type PolicyName = 'boris' | 'lazy' | 'random' | 'greedy' | 'oracle'

/** Унифицированная запись действия — пишется фейк-клиентом при любом write. */
export interface CapturedAction {
  day: number
  type: 'bid_set' | 'negatives_set' | 'keywords_suspend' | 'campaign_suspend' | 'daily_budget' | 'metrica_tag_restore'
  /** Для bid_set: [{keywordId, toMicro}]; для negatives_set: полный новый список. */
  payload: unknown
  /** Кто записал: реальный write-gate Бориса или бот напрямую. */
  by: PolicyName
}

/** Машинная запись решения Бориса (фаза 0: ProcessResult.decisions). */
export interface DecisionRecord {
  type: 'bid' | 'minus' | 'hold' | 'proposal' | 'suspend' | 'alert' | 'diagnosis'
  targetType: 'keyword' | 'query' | 'adgroup' | 'campaign'
  targetId: string
  summary: string
  reasonCode: ReasonCode
  factors: Record<string, number | string>
}

export interface CapturedProposal {
  day: number
  type: string
  topicKey: string
  payloadSummary: string
  /** Решение владельца-бота: approved/rejected (по правде мира). */
  ownerDecision: 'approved' | 'rejected' | 'expired'
  /** Было ли предложение ВЕРНЫМ по правде (для точности предложений). */
  wasCorrect: boolean
}

/** Результат прогона одной политики на одном (сценарий, зерно). */
export interface RunResult {
  scenarioId: string
  set: ScenarioSet
  seed: number
  policy: PolicyName
  days: number
  /** Экономика: суммарно за прогон. */
  spendRub: number
  leads: number // настоящие заявки (без пустышек) — правда мира
  leadsObserved: number // сколько заявок видел Борис (с пустышками)
  actions: CapturedAction[]
  decisions: DecisionRecord[] // у ботов пусто или синтетика оракула
  proposals: CapturedProposal[]
  alerts: Array<{ day: number; kind: string; text: string }>
  /** Ворота надёжности: падения/решения на битых данных. */
  reliability: { crashed: boolean; crashNote?: string; silentOnBrokenData: boolean }
}

// ============================================================
// Оракул и эталоны
// ============================================================

/** Эталонное действие оракула по фразе/запросу на день. */
export interface OracleVerdicts {
  /** Запросы, которые ДОЛЖНЫ быть заминусованы (истинный мусор с достат. объёмом). */
  mustMinus: Set<string>
  /** Запросы, которые НЕЛЬЗЯ минусовать (живой трафик; резать = ошибка с ценой). */
  mustKeep: Set<string>
  /** Оптимальный уровень TV по фразе на конец прогона: keywordId → 15|55|75|null (null = не трогать/недостижимо). */
  optimalTv: Map<number, number | null>
  /** Истинный код причины по субъектам (из expectations + вычисленного). */
  causeCodes: Record<string, ReasonCode>
  /**
   * Эталон атрибуции «лучший вывод из наблюдаемого»: leadKey(phoneDigits+day) →
   * {adGroupId, query|null}. Отдельно всезнающий вариант для зазора.
   */
  attributionInferable: Map<string, { adGroupId: string; query: string | null }>
  attributionOmniscient: Map<string, { adGroupId: string; query: string | null }>
}

// ============================================================
// Скоринг
// ============================================================

export type CategoryKey =
  | 'economics' // 30
  | 'diagnosis' // 20
  | 'bids' // 10
  | 'minus' // 10
  | 'attribution' // 10
  | 'anomalies' // 8
  | 'discipline' // 7
  | 'memory' // 5

// Веса после калибровки честности (виток линейки 2026-07-03, утв. владельцем).
// Сдвинуто в сторону economics (north star) + diagnosis (рассуждение).
// attribution=0: категория считается и показывается, но ИЗ ТОТАЛА ИСКЛЮЧЕНА —
// group-атрибуция структурно тривиальна (каждый ключ ровно в одной группе,
// 752/752), шумом utm не спасается; дискриминирующий тест (phrase-level или
// конвертящая кросс-групповая неоднозначность) — задача будущего витка полигона.
// Было → стало: economics 30→35, diagnosis 20→25, attribution 10→0.
export const CATEGORY_WEIGHTS: Record<CategoryKey, number> = {
  economics: 35,
  diagnosis: 25,
  bids: 10,
  minus: 10,
  attribution: 0,
  anomalies: 8,
  discipline: 7,
  memory: 5,
}

export interface CategoryScore {
  key: CategoryKey
  /** 0..100 внутри категории. */
  score: number
  /** Человекочитаемые промахи для разбора ошибок. */
  misses: string[]
}

export interface ScenarioScore {
  scenarioId: string
  set: ScenarioSet
  seed: number
  policy: PolicyName
  categories: CategoryScore[]
  /** Взвешенная сумма 0..100 (после ворот надёжности). */
  total: number
  reliabilityGateTripped: boolean
  /** «Правильно по неверной причине», % от верных действий. */
  rightForWrongReasonPct: number
}

export interface MatrixSummary {
  policy: PolicyName
  set: ScenarioSet
  scenarios: number
  seeds: number
  /** Средний total ± стандартное отклонение. */
  meanTotal: number
  stdTotal: number
  byCategory: Record<CategoryKey, number>
  rightForWrongReasonPct: number
  reliabilityTrips: number
}

// ============================================================
// Раннер
// ============================================================

export interface RunnerOptions {
  set: ScenarioSet | 'calibration' | 'metamorphic'
  policy: PolicyName
  seeds: number[]
  /** 'live' = реальный Haiku с кешем; 'stub' = детерминированная эвристика без сети. */
  llmMode: 'live' | 'stub'
  outDir: string
}

/** Ключ заявки для эталонов атрибуции. */
export function leadKey(phoneDigits: string, day: number): string {
  return `${phoneDigits}@${day}`
}
