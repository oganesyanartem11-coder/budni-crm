/**
 * ГЛУБОКАЯ ДИАГНОСТИКА Бориса-Директа (сессия «Прозрение»).
 *
 * Чистые функции: на вход — уже собранные мозгом цифры (срезы Метрики,
 * корректировки, расписание, конвертящие запросы), на выход — машинный
 * диагноз (DecisionRecord) + ПРЕДЛОЖЕНИЕ владельцу. Действий Бориса НЕ
 * меняют и write-набор НЕ расширяют: применение новых типов правок
 * (расписание, корректировки ставок, групповые минуса) — ТОЛЬКО после
 * пробы на ТЕСТОВОЙ кампании и явного «да» владельца. Поэтому Борис в
 * предложении прямо пишет «готов применить после пробы на тесте — жду добро».
 *
 * Пороги эмиссии — в config.ts (DEVICE_SKEW_*, SCHEDULE_*, AUDIENCE_*,
 * GROUP_MINUS_GAP_*). Все диагнозы объёмно-гейтованы: на молодой/тонкой
 * кампании они молчат (шум не выпускаем).
 */

import type { DecisionRecord } from './reason-codes'
import {
  DIRECT_CAMPAIGN_ID,
  DEVICE_SKEW_MIN_CLICKS,
  DEVICE_SKEW_ZERO_CONV,
  SCHEDULE_MIN_WEEKEND_SPEND_RUB,
  SCHEDULE_MIN_WEEKEND_DAYS,
  AUDIENCE_MIN_VISITS,
  GROUP_MINUS_GAP_MIN_CONV,
  GROUP_MINUS_GAP_MIN_CLICKS,
} from './config'

/** Предложение владельцу — структурно совместимо с ProcessResult.proposalDrafts. */
export interface DiagProposal {
  type: string
  topicKey: string
  payload: unknown
  argument: string
  question: string
  triggerMetric?: string
  triggerValue?: number
}

/** Пара «машинный диагноз + предложение владельцу». */
export interface DiagnosisOutput {
  decision: DecisionRecord
  proposal: DiagProposal
}

const CID = String(DIRECT_CAMPAIGN_ID)
const r2 = (x: number): number => Math.round(x * 100) / 100

// ---------- Общее: сопоставление минус-фразы и запроса ----------

/** Токены фразы без операторов Директа (! + " [ ]), нижний регистр. */
function tokens(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .replace(/[!+"[\]]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/**
 * Приблизительная семантика минус-фразы Директа: минус блокирует запрос, если
 * ВСЕ слова минус-фразы присутствуют в запросе. Аппроксимация (без тонкостей
 * стоп-слов/словоформ) — для ДИАГНОЗА (владелец решает), сознательно
 * склонна пере-флагать, а не пропустить.
 */
export function minusPhraseBlocksQuery(negative: string, query: string): boolean {
  const negTokens = tokens(negative)
  if (negTokens.length === 0) return false
  const qTokens = new Set(tokens(query))
  return negTokens.every((t) => qTokens.has(t))
}

/** Номер дня недели календарной МСК-даты 'YYYY-MM-DD' (0=вс … 6=сб). */
export function weekdayOfMskDay(date: string): number {
  // Дату трактуем как календарную (UTC-полночь) — getUTCDay даёт верный будень.
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}
export function isWeekend(date: string): boolean {
  const d = weekdayOfMskDay(date)
  return d === 0 || d === 6
}

// ---------- Нормализация срезов под диагнозы ----------

/** Метка устройства Метрики/отчёта → DESKTOP | MOBILE | TABLET (иначе как есть). */
export function normalizeDevice(name: string): string {
  const n = name.toLowerCase()
  if (/pc|desktop|компьютер/.test(n)) return 'DESKTOP'
  if (/tablet|планшет/.test(n)) return 'TABLET'
  if (/phone|smartphone|mobil|смартфон|телефон/.test(n)) return 'MOBILE'
  return name.toUpperCase()
}

/** Устройства, у которых УЖЕ есть корректировка ставки (из bidmodifiers.get). */
export function adjustedDeviceTypes(mods: Array<{ Type: string }>): Set<string> {
  const s = new Set<string>()
  for (const m of mods) {
    const t = (m.Type ?? '').toUpperCase()
    if (/MOBILE|SMARTPHONE/.test(t)) s.add('MOBILE')
    else if (/DESKTOP/.test(t)) s.add('DESKTOP')
    else if (/TABLET/.test(t)) s.add('TABLET')
  }
  return s
}

/**
 * Канонический ключ demo-сегмента для сверки Директ↔Метрика (разные словари):
 * пол → gender:male|female; возраст → age:25-34 / age:55+. Срезает префикс «Age »,
 * приводит неразрывный дефис (‑, U+2011) и подчёркивание к обычному дефису.
 * Метрика: 'gender:male' / 'age:Age 25‑34'; Директ: GENDER_MALE / AGE_25_34.
 */
export function canonicalizeDemoSegment(label: string): string {
  const s = label.toLowerCase().replace(/[‑_]/g, '-')
  if (s.includes('female')) return 'gender:female' // проверяем female ДО male (подстрока)
  if (s.includes('male')) return 'gender:male'
  const plus = s.match(/(\d+)\s*\+/)
  if (plus) return `age:${plus[1]}+`
  const range = s.match(/(\d+)\s*-\s*(\d+)/)
  if (range) return `age:${range[1]}-${range[2]}`
  return s
}

/**
 * Множество УЖЕ настроенных demo-сегментов (канонические ключи) из bidmodifiers.get:
 * DemographicsAdjustment по полу и/или возрасту. Чтобы AUDIENCE_WASTE не предлагал
 * владельцу корректировку, которая уже стоит.
 */
export function adjustedDemoSegments(
  mods: Array<{ DemographicsAdjustment?: { Age?: string; Gender?: string } }>
): Set<string> {
  const s = new Set<string>()
  for (const m of mods) {
    const d = m.DemographicsAdjustment
    if (!d) continue
    if (d.Gender) s.add(canonicalizeDemoSegment(d.Gender))
    if (d.Age) s.add(canonicalizeDemoSegment(d.Age))
  }
  return s
}

/** Сегменты пол/возраст из demo-среза Метрики (агрегат отдельно по полу и по возрасту). */
export function buildDemoSegments(
  rows: Array<{ gender: string; age: string; visits: number; goalReaches: number }>
): DemoSegment[] {
  const byGender = new Map<string, { v: number; g: number }>()
  const byAge = new Map<string, { v: number; g: number }>()
  for (const r of rows) {
    if (r.gender) {
      const a = byGender.get(r.gender) ?? { v: 0, g: 0 }
      a.v += r.visits
      a.g += r.goalReaches
      byGender.set(r.gender, a)
    }
    if (r.age) {
      const a = byAge.get(r.age) ?? { v: 0, g: 0 }
      a.v += r.visits
      a.g += r.goalReaches
      byAge.set(r.age, a)
    }
  }
  const out: DemoSegment[] = []
  for (const [k, a] of byGender) out.push({ label: `gender:${k}`, kind: 'gender', visits: a.v, conversions: a.g })
  for (const [k, a] of byAge) out.push({ label: `age:${k}`, kind: 'age', visits: a.v, conversions: a.g })
  return out
}

// ---------- 1. DEVICE_SKEW ----------

export interface DeviceRow {
  /** Нормализованный тип: DESKTOP | MOBILE | TABLET (как в отчётах/Метрике). */
  device: string
  clicks: number
  conversions: number
  /** Расход на устройстве, ₽ (точный из отчёта или оценка по доле визитов). */
  costRub: number
  /** Оценочный ли costRub (по доле визитов), а не точный из Direct-отчёта. */
  costEstimated?: boolean
}

/**
 * DEVICE_SKEW: устройство с объёмом (≥DEVICE_SKEW_MIN_CLICKS кликов) и НУЛЁМ
 * заявок при том, что на других устройствах заявки идут, и понижающей
 * корректировки на него НЕТ. Слив бюджета на неконвертящем устройстве.
 */
export function diagnoseDeviceSkew(
  rows: DeviceRow[],
  adjustedDeviceTypes: Set<string>
): DiagnosisOutput | null {
  if (rows.length < 2) return null
  const totalConv = rows.reduce((a, r) => a + r.conversions, 0)
  if (totalConv <= 0) return null // никто не конвертит — вопрос не к устройствам

  const drain = rows
    .filter(
      (r) =>
        r.conversions <= DEVICE_SKEW_ZERO_CONV &&
        r.clicks >= DEVICE_SKEW_MIN_CLICKS &&
        !adjustedDeviceTypes.has(r.device)
    )
    .sort((a, b) => b.costRub - a.costRub)[0]
  if (!drain) return null

  const cost = r2(drain.costRub)
  const est = drain.costEstimated ? '≈' : ''
  const summary =
    `${drain.device}: ${drain.clicks} кликов, ${est}${cost} ₽, 0 заявок — при заявках на других устройствах (всего ${totalConv}); понижающей корректировки нет`
  return {
    decision: {
      type: 'diagnosis',
      targetType: 'campaign',
      targetId: CID,
      summary,
      reasonCode: 'DEVICE_SKEW',
      factors: { device: drain.device, clicks: drain.clicks, costRub: cost, conversions: 0, totalConv },
    },
    proposal: {
      type: 'device_skew',
      topicKey: `device_skew:${drain.device}`,
      payload: { device: drain.device, clicks: drain.clicks, costRub: cost, costEstimated: !!drain.costEstimated },
      argument:
        `За период на устройстве ${drain.device} — ${drain.clicks} кликов и ${est}${cost} ₽ расхода при 0 заявок, ` +
        `тогда как на других устройствах заявки идут (всего ${totalConv}). Понижающая корректировка ставки на ` +
        `${drain.device} (bidmodifiers) уберёт слив — та же заявка дешевле. Готов применить после пробы на ` +
        `тестовой кампании — жду добро.`,
      question: `Поставить понижающую корректировку на ${drain.device}?`,
      triggerMetric: 'device_zero_conv_cost',
      triggerValue: cost,
    },
  }
}

// ---------- 2. SCHEDULE_WASTE ----------

/** Форма TimeTargeting из campaigns.get (только нужные для разбора поля). */
export interface TimeTargetingLike {
  Schedule?: { Items?: string[] } | null
}

/**
 * Есть ли РЕАЛЬНОЕ расписание показов (ограничение времени), а не «крутимся 24/7».
 *
 * Директ ВСЕГДА отдаёт TimeTargeting у активной кампании, поэтому старое
 * `!!TimeTargeting` считало расписание настроенным ВСЕГДА и SCHEDULE_WASTE был
 * мёртв с рождения (аудит 14.07: выходные съедали ~4.6 т.₽/2 уикенда при 0 заявок,
 * а диагноз молчал). Реальное расписание = хотя бы один час с коэффициентом < 100
 * (показ ограничен). Формат Items: "<день>,<ч0>,<ч1>,…,<ч23>" (25 значений).
 *
 * ИНВАРИАНТ ПОЛИГОНА (byte-identical): sim-фейк отдаёт либо undefined, либо
 * { Schedule: { Items: [] } }. Правило «24/7 ⇔ Items НЕПУСТЫ И все часы = 100»
 * сохраняет оба случая идентично старому `!!TimeTargeting`:
 *  - undefined → false (как !!undefined);
 *  - пустые Items → true (как !!{…}); 24/7-фикс их не трогает.
 * Только НЕПУСТЫЕ all-100 Items (реальный кабинет) дают false — оживление диагноза.
 */
export function hasRealSchedule(tt: TimeTargetingLike | null | undefined): boolean {
  if (!tt) return false
  const items = tt.Schedule?.Items ?? []
  if (items.length === 0) return true // пусто → как старый !!TimeTargeting (полигон)
  // Все часы во всех строках = 100 → 24/7, реального ограничения нет → false.
  for (const item of items) {
    const parts = item.split(',')
    // parts[0] — день недели; часы — со второго значения.
    for (let i = 1; i < parts.length; i++) {
      const v = Number(parts[i].trim())
      if (Number.isFinite(v) && v !== 100) return true // ограничение есть
    }
  }
  return false // все 100 → круглосуточно, расписания фактически нет
}

export interface WeekendAggRow {
  /** МСК-день 'YYYY-MM-DD'. */
  day: string
  costRub: number
  /** Конверсии Директ-отчёта (readReportConversions) — заморожены на момент collect. */
  conversions: number
}

/**
 * Агрегат будни/выходные для SCHEDULE_WASTE. Конверсии ВЫХОДНОГО дня = МАКСИМУМ из
 * двух источников: заморожённые конверсии Директ-отчёта (могли отставать из-за лага
 * атрибуции на момент collect) И ФАКТИЧЕСКИ доставленные Директ-заявки (LandingLead
 * fromDirect — ground truth, по МСК-дню заявки). Если в выходной пришла заявка, но
 * отчёт её ещё не отразил — день считается сконвертившим, диагноз не горит ложно
 * (BUG 2, аудит 16.07: вс 05.07 — доставленный лид, а отчётные конверсии дня = 0).
 *
 * ПУСТОЙ deliveredByDay → поведение как раньше (только отчёт): для полигона нейтрально,
 * когда в мире нет доставленных ВЫХОДНЫХ Директ-заявок в днях с расходом. Порог/гейт
 * диагноза НЕ трогаем — чиним только СЧЁТ заявок (источник данных).
 */
export function aggregateWeekendStats(
  rows: WeekendAggRow[],
  deliveredByDay: ReadonlyMap<string, number>
): { weekendSpendRub: number; weekendConversions: number; weekendDays: number; weekdayConversions: number } {
  const byDay = new Map<string, { spend: number; conv: number }>()
  for (const r of rows) {
    const cur = byDay.get(r.day) ?? { spend: 0, conv: 0 }
    cur.spend += r.costRub
    cur.conv += r.conversions
    byDay.set(r.day, cur)
  }
  let weekendSpendRub = 0
  let weekendConversions = 0
  let weekendDays = 0
  let weekdayConversions = 0
  for (const [day, agg] of byDay) {
    if (isWeekend(day)) {
      weekendSpendRub += agg.spend
      // ФАКТ-приоритет: max(отчёт, доставленные) — заявка была → день сконвертил.
      weekendConversions += Math.max(agg.conv, deliveredByDay.get(day) ?? 0)
      if (agg.spend > 0) weekendDays++
    } else {
      weekdayConversions += agg.conv
    }
  }
  return { weekendSpendRub, weekendConversions, weekendDays, weekdayConversions }
}

export interface ScheduleInput {
  weekendSpendRub: number
  weekendConversions: number
  /** Сколько выходных ДНЕЙ с расходом попало в окно. */
  weekendDays: number
  weekdayConversions: number
  /** Настроено ли расписание показов (TimeTargeting). Есть → тему не поднимаем. */
  hasSchedule: boolean
}

/**
 * SCHEDULE_WASTE: расписание показов НЕ задано (крутимся 24/7), выходные
 * набрали заметный расход при 0 заявок, а будни конвертят — B2B-кампания
 * платит за мёртвое время.
 */
export function diagnoseScheduleWaste(input: ScheduleInput): DiagnosisOutput | null {
  if (input.hasSchedule) return null
  if (input.weekendDays < SCHEDULE_MIN_WEEKEND_DAYS) return null
  if (input.weekendSpendRub < SCHEDULE_MIN_WEEKEND_SPEND_RUB) return null
  if (input.weekendConversions > 0) return null
  if (input.weekdayConversions <= 0) return null // будни тоже без заявок — не про расписание

  const spend = r2(input.weekendSpendRub)
  const summary =
    `выходные (${input.weekendDays} дн): ${spend} ₽ расхода, 0 заявок; будни конвертят; расписание показов не настроено (24/7)`
  return {
    decision: {
      type: 'diagnosis',
      targetType: 'campaign',
      targetId: CID,
      summary,
      reasonCode: 'SCHEDULE_WASTE',
      factors: {
        weekendSpendRub: spend,
        weekendDays: input.weekendDays,
        weekendConversions: 0,
        weekdayConversions: input.weekdayConversions,
      },
    },
    proposal: {
      type: 'schedule_waste',
      topicKey: 'schedule_waste',
      payload: { weekendSpendRub: spend, weekendDays: input.weekendDays },
      argument:
        `У нас B2B (доставка обедов на коллективы) — заявки идут в будни. За период выходные съели ${spend} ₽ ` +
        `при 0 заявок, а расписание показов не задано (крутимся круглосуточно и по выходным). Ограничение показов ` +
        `рабочим временем/буднями уберёт пустой расход — дешевле заявка. Готов применить после пробы на тестовой ` +
        `кампании — жду добро.`,
      question: 'Настроить расписание показов (будни/рабочие часы)?',
      triggerMetric: 'weekend_spend_no_conv',
      triggerValue: spend,
    },
  }
}

// ---------- 3. AUDIENCE_WASTE ----------

export interface DemoSegment {
  /** Метка сегмента: например 'gender:male' | 'age:45-54'. */
  label: string
  kind: 'gender' | 'age'
  visits: number
  conversions: number
}

/**
 * AUDIENCE_WASTE: сегмент пол/возраст с объёмом (≥AUDIENCE_MIN_VISITS визитов)
 * и НУЛЁМ заявок при конвертящей кампании и без понижающей демо-корректировки.
 * Порог высокий: у B2B ЛПР размазаны по демографии — флагаем осторожно.
 */
export function diagnoseAudienceWaste(
  segments: DemoSegment[],
  overallConversions: number,
  adjustedSegments: Set<string>
): DiagnosisOutput | null {
  if (overallConversions <= 0) return null
  const drain = segments
    .filter(
      (s) =>
        s.conversions === 0 &&
        s.visits >= AUDIENCE_MIN_VISITS &&
        !adjustedSegments.has(canonicalizeDemoSegment(s.label))
    )
    .sort((a, b) => b.visits - a.visits)[0]
  if (!drain) return null

  const summary =
    `${drain.label}: ${drain.visits} визитов, 0 заявок при конвертящей кампании (всего ${overallConversions}); демо-корректировки нет`
  return {
    decision: {
      type: 'diagnosis',
      targetType: 'campaign',
      targetId: CID,
      summary,
      reasonCode: 'AUDIENCE_WASTE',
      factors: { segment: drain.label, visits: drain.visits, conversions: 0, overallConversions },
    },
    proposal: {
      type: 'audience_waste',
      topicKey: `audience_waste:${drain.label}`,
      payload: { segment: drain.label, visits: drain.visits },
      argument:
        `Сегмент ${drain.label} набрал ${drain.visits} визитов и 0 заявок за период, тогда как кампания в целом ` +
        `конвертит (${overallConversions} заявок). Понижающая корректировка на этот сегмент (bidmodifiers, ` +
        `демография) уберёт нецелевой расход. Внимание: на B2B демография размазана — предлагаю с осторожностью. ` +
        `Готов применить после пробы на тестовой кампании — жду добро.`,
      question: `Поставить понижающую корректировку на сегмент ${drain.label}?`,
      triggerMetric: 'segment_zero_conv_visits',
      triggerValue: drain.visits,
    },
  }
}

// ---------- 4. GROUP_MINUS_GAP ----------

export interface ConvertingQuery {
  query: string
  adGroupId: string
  adGroupName?: string
  clicks: number
  conversions: number
}

/**
 * GROUP_MINUS_GAP: минус-фраза уровня КАМПАНИИ задевает конвертящий запрос
 * конкретной группы. Кампейн-минус бьёт по всем группам → режет живой
 * трафик группы (сценарий каннибализации). Точечное лечение — перенести минус
 * на уровень нужных групп. Один диагноз на задевающий минус (сильнейший запрос).
 */
export function diagnoseGroupMinusGap(
  campaignNegatives: string[],
  convertingQueries: ConvertingQuery[]
): DiagnosisOutput[] {
  const eligible = convertingQueries.filter(
    (q) => q.conversions >= GROUP_MINUS_GAP_MIN_CONV && q.clicks >= GROUP_MINUS_GAP_MIN_CLICKS
  )
  if (eligible.length === 0) return []

  const out: DiagnosisOutput[] = []
  for (const neg of campaignNegatives) {
    const hit = eligible
      .filter((q) => minusPhraseBlocksQuery(neg, q.query))
      .sort((a, b) => b.conversions - a.conversions || b.clicks - a.clicks)[0]
    if (!hit) continue
    const group = hit.adGroupName ?? hit.adGroupId
    const summary =
      `минус кампании «${neg}» задевает конвертящий запрос «${hit.query}» группы ${group} (${hit.conversions} заявок, ${hit.clicks} кликов) — режет живой трафик группы`
    out.push({
      decision: {
        type: 'diagnosis',
        targetType: 'adgroup',
        targetId: hit.adGroupId,
        summary,
        reasonCode: 'GROUP_MINUS_GAP',
        factors: {
          negative: neg,
          query: hit.query,
          adGroupId: hit.adGroupId,
          conversions: hit.conversions,
          clicks: hit.clicks,
        },
      },
      proposal: {
        type: 'group_minus_gap',
        topicKey: `group_minus_gap:${neg}`,
        payload: { negative: neg, query: hit.query, adGroupId: hit.adGroupId, adGroupName: hit.adGroupName ?? null },
        argument:
          `Минус-фраза «${neg}» стоит на уровне ВСЕЙ кампании, но задевает конвертящий запрос «${hit.query}» ` +
          `группы ${group} (${hit.conversions} заявок, ${hit.clicks} кликов). Кампейн-минус бьёт по всем группам — ` +
          `убивает живой трафик этой группы. Перенести минус на уровень нужных групп (где он мусор), сняв с ` +
          `кампании. Готов применить после пробы на тестовой кампании — жду добро.`,
        question: `Перенести минус «${neg}» с кампании на уровень групп?`,
        triggerMetric: 'blocked_converting_clicks',
        triggerValue: hit.clicks,
      },
    })
  }
  return out
}
