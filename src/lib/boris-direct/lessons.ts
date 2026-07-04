/**
 * Уроки Бориса-Директа (память-опыт): вывод КОДОМ по правилам из
 * BorisDirectQueryDailyStat/ActionLog, еженедельная перепроверка
 * (подтверждён/опровергнут/устарел), жёстко лимитированная секция
 * «ОПЫТ» для промпта и отчёт «Борис, что ты понял».
 *
 * Принципы:
 * - ВСЯ арифметика — код, без LLM; тексты — детерминированные шаблоны с цифрами;
 * - пороги ТОЛЬКО из config;
 * - одна неделя сигнала — не повод: урок рождается после LESSON_CONFIRM_WEEKS
 *   полных недель (пн-вс МСК) подряд и минимума кликов;
 * - неподтверждённый данными урок стареет (STALE), развернувшийся — REFUTED.
 */

import type { BorisDirectLesson, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import {
  LESSON_BLOCK_MAX_CHARS,
  LESSON_CHEAP_CPL_RATIO,
  LESSON_CONFIRM_WEEKS,
  LESSON_EXPENSIVE_CPL_RATIO,
  LESSON_MIN_CLICKS,
  LESSON_STALE_WEEKS,
  LESSON_TOP_K,
} from './config'
import { mskDay, mskDayStartUtc } from './brain'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

export interface LessonForContext {
  id: string
  kind: string
  text: string
}

export interface LessonsRefreshResult {
  created: number
  confirmed: number
  refuted: number
  staled: number
}

// ---------- Недели МСК (пн-вс) ----------

/** Понедельник 00:00 МСК ТЕКУЩЕЙ недели как UTC-момент. */
function currentWeekStartUtc(now: Date): Date {
  const day = mskDay(now) // 'YYYY-MM-DD' в МСК
  const dayOfWeek = new Date(`${day}T00:00:00Z`).getUTCDay() // 0=вс … 6=сб
  const sinceMonday = (dayOfWeek + 6) % 7
  return new Date(mskDayStartUtc(day).getTime() - sinceMonday * DAY_MS)
}

// ---------- Агрегаты по неделям ----------

interface GroupWeek {
  adGroupName: string
  clicks: number
  costRub: number
  conversions: number
}

interface WeekAggregates {
  /** Понедельник недели (UTC-момент начала МСК-дня). */
  weekStart: Date
  byGroup: Map<string, GroupWeek>
  /** Средняя цена заявки по кампании за неделю (null = заявок не было). */
  campaignCpl: number | null
  /** Средний расход групп недели (для сигнала «тратит без заявок»). */
  avgGroupCost: number
}

/**
 * Агрегаты QueryDailyStat по adGroupId за weeksBack последних ПОЛНЫХ недель.
 * Индекс 0 — последняя полная неделя, 1 — предыдущая и т.д.
 */
async function loadWeeklyAggregates(now: Date, weeksBack: number): Promise<WeekAggregates[]> {
  const currentMonday = currentWeekStartUtc(now)
  const spanStart = new Date(currentMonday.getTime() - weeksBack * WEEK_MS)
  const rows = await prisma.borisDirectQueryDailyStat.findMany({
    where: { date: { gte: spanStart, lt: currentMonday } },
    select: {
      date: true,
      adGroupId: true,
      adGroupName: true,
      clicks: true,
      costRub: true,
      conversions: true,
    },
  })

  const weeks: WeekAggregates[] = []
  for (let i = 0; i < weeksBack; i++) {
    weeks.push({
      weekStart: new Date(currentMonday.getTime() - (i + 1) * WEEK_MS),
      byGroup: new Map(),
      campaignCpl: null,
      avgGroupCost: 0,
    })
  }

  for (const row of rows) {
    const diff = currentMonday.getTime() - new Date(row.date).getTime()
    const index = Math.ceil(diff / WEEK_MS) - 1
    if (index < 0 || index >= weeksBack) continue
    const week = weeks[index]
    const group = week.byGroup.get(row.adGroupId) ?? {
      adGroupName: row.adGroupName,
      clicks: 0,
      costRub: 0,
      conversions: 0,
    }
    group.clicks += row.clicks
    group.costRub += Number(row.costRub) // Decimal → number
    group.conversions += row.conversions
    week.byGroup.set(row.adGroupId, group)
  }

  for (const week of weeks) {
    let cost = 0
    let conversions = 0
    for (const group of week.byGroup.values()) {
      cost += group.costRub
      conversions += group.conversions
    }
    week.campaignCpl = conversions > 0 ? cost / conversions : null
    week.avgGroupCost = week.byGroup.size > 0 ? cost / week.byGroup.size : 0
  }
  return weeks
}

// ---------- Сигналы экономики группы ----------

type GroupSignal = 'cheap' | 'expensive' | 'waste'
/** middle = данных достаточно, но сигнала нет; insufficient = мало данных. */
type WeekSignal = GroupSignal | 'middle' | 'insufficient'

/** Сторона порога: cheap против expensive/waste (для подтверждения/опровержения). */
function signalSide(signal: WeekSignal): 'cheap' | 'expensive' | null {
  if (signal === 'cheap') return 'cheap'
  if (signal === 'expensive' || signal === 'waste') return 'expensive'
  return null
}

/** Сигнал группы за неделю по порогам из config. */
function groupWeekSignal(group: GroupWeek | undefined, week: WeekAggregates): WeekSignal {
  if (!group || group.clicks < LESSON_MIN_CLICKS) return 'insufficient'
  if (group.conversions === 0) {
    // «Тратит без заявок»: расход не меньше среднего расхода групп недели.
    if (week.avgGroupCost > 0 && group.costRub >= week.avgGroupCost) return 'waste'
    return 'insufficient' // клики есть, но расход мал — не притягиваем
  }
  if (week.campaignCpl === null || week.campaignCpl <= 0) return 'insufficient'
  const cpl = group.costRub / group.conversions
  if (cpl <= LESSON_CHEAP_CPL_RATIO * week.campaignCpl) return 'cheap'
  if (cpl >= LESSON_EXPENSIVE_CPL_RATIO * week.campaignCpl) return 'expensive'
  return 'middle'
}

// ---------- Чтение evidence/outcomeData из JSON (не доверяем структуре) ----------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Какой сигнал зафиксирован в evidence урока group_economics. */
function evidenceSignal(evidence: unknown): GroupSignal | null {
  const signal = asRecord(evidence).signal
  return signal === 'cheap' || signal === 'expensive' || signal === 'waste' ? signal : null
}

/** Цифры окна из outcomeData ActionLog (пишет outcomes.ts). */
function outcomeWindow(raw: unknown, key: 'before' | 'after'): {
  cpl: number | null
  costRub: number | null
} {
  const window = asRecord(asRecord(raw)[key])
  return { cpl: asNumber(window.cpl), costRub: asNumber(window.costRub) }
}

const fmtRub = (value: number): string => String(Math.round(value))

// ---------- Тексты уроков (детерминированные шаблоны) ----------

interface GroupPeriodTotals {
  cpl: number | null
  campaignCpl: number | null
  costRub: number
}

function buildGroupLessonText(
  signal: GroupSignal,
  name: string,
  totals: GroupPeriodTotals,
  weeksCount: number
): string {
  const cpl = totals.cpl === null ? '?' : fmtRub(totals.cpl)
  const avg = totals.campaignCpl === null ? '?' : fmtRub(totals.campaignCpl)
  if (signal === 'cheap') {
    return `Группа ${name}: заявки дешевле среднего — ${cpl} ₽ против ${avg} ₽ по кампании (${weeksCount} нед. подряд)`
  }
  if (signal === 'expensive') {
    return `Группа ${name}: заявки дороже среднего — ${cpl} ₽ против ${avg} ₽ по кампании (${weeksCount} нед. подряд), осторожнее со ставками`
  }
  return `Группа ${name}: тратит без заявок — ${fmtRub(totals.costRub)} ₽ расхода и 0 заявок за ${weeksCount} нед. подряд, кандидат на разбор`
}

function buildActionLessonText(
  action: string,
  createdAt: Date,
  verdict: 'improved' | 'worse',
  outcomeData: unknown
): string {
  const day = mskDay(createdAt)
  const ddmm = `${day.slice(8, 10)}.${day.slice(5, 7)}`
  const before = outcomeWindow(outcomeData, 'before')
  const after = outcomeWindow(outcomeData, 'after')
  const was = before.cpl === null ? '?' : fmtRub(before.cpl)
  if (verdict === 'improved') {
    const became = after.cpl === null ? '?' : fmtRub(after.cpl)
    return `${action} от ${ddmm}: окупилось — цена заявки ${was} → ${became} ₽`
  }
  if (after.cpl === null) {
    const spent = after.costRub === null ? '?' : fmtRub(after.costRub)
    return `${action} от ${ddmm}: не окупилось — заявки пропали (расход ${spent} ₽ без конверсий)`
  }
  return `${action} от ${ddmm}: не окупилось — цена заявки ${was} → ${fmtRub(after.cpl)} ₽`
}

// ---------- Evidence недели для урока ----------

function weekEvidence(week: WeekAggregates, group: GroupWeek | undefined) {
  return {
    weekStart: week.weekStart.toISOString(),
    clicks: group?.clicks ?? 0,
    costRub: group?.costRub ?? 0,
    conversions: group?.conversions ?? 0,
    cpl: group && group.conversions > 0 ? group.costRub / group.conversions : null,
    campaignCpl: week.campaignCpl,
    avgGroupCost: week.avgGroupCost,
  }
}

// ---------- Двухфазный вывод/перепроверка ----------

export async function deriveAndRefreshLessons(now: Date = new Date()): Promise<LessonsRefreshResult> {
  const result: LessonsRefreshResult = { created: 0, confirmed: 0, refuted: 0, staled: 0 }
  const confirmWeeks = Math.max(LESSON_CONFIRM_WEEKS, 1)
  const weeks = await loadWeeklyAggregates(now, confirmWeeks)
  const lastWeek = weeks[0]
  const allLessons = await prisma.borisDirectLesson.findMany()
  const staleAgeMs = LESSON_STALE_WEEKS * WEEK_MS

  // ФАЗА 1 — перепроверка существующих уроков (ошибка одного не роняет остальные).
  for (const lesson of allLessons) {
    if (lesson.status === 'REFUTED') continue
    try {
      if (lesson.kind === 'group_economics') {
        await recheckGroupLesson(lesson, lastWeek, now, staleAgeMs, result)
      } else if (lesson.kind === 'action_outcome') {
        // Исход — исторический факт: не перепроверяется, только стареет.
        if (
          lesson.status === 'ACTIVE' &&
          now.getTime() - lesson.createdAt.getTime() > staleAgeMs
        ) {
          await prisma.borisDirectLesson.update({
            where: { id: lesson.id },
            data: { status: 'STALE' },
          })
          result.staled += 1
        }
      }
    } catch (err) {
      console.error(`[boris-direct/lessons] перепроверка урока ${lesson.id} не удалась:`, err)
    }
  }

  // ФАЗА 2а — новые уроки group_economics: сигнал в КАЖДОЙ из confirmWeeks недель.
  const groupIds = new Set<string>()
  for (const week of weeks) for (const id of week.byGroup.keys()) groupIds.add(id)
  // Дедуп: любой не-REFUTED урок по тому же субъекту блокирует создание.
  const busyGroupSubjects = new Set(
    allLessons
      .filter((l) => l.kind === 'group_economics' && l.status !== 'REFUTED' && l.subjectId)
      .map((l) => l.subjectId as string)
  )

  for (const adGroupId of groupIds) {
    try {
      if (busyGroupSubjects.has(adGroupId)) continue
      const signals = weeks.map((week) => groupWeekSignal(week.byGroup.get(adGroupId), week))
      const signal = (['cheap', 'expensive', 'waste'] as const).find((candidate) =>
        signals.every((s) => s === candidate)
      )
      if (!signal) continue

      // Цифры для текста — за весь период confirmWeeks недель.
      let clicks = 0
      let costRub = 0
      let conversions = 0
      let campaignCost = 0
      let campaignConversions = 0
      let name = adGroupId
      for (const week of weeks) {
        const group = week.byGroup.get(adGroupId)
        if (group) {
          clicks += group.clicks
          costRub += group.costRub
          conversions += group.conversions
          name = group.adGroupName || name
        }
        for (const other of week.byGroup.values()) {
          campaignCost += other.costRub
          campaignConversions += other.conversions
        }
      }
      const totals: GroupPeriodTotals = {
        cpl: conversions > 0 ? costRub / conversions : null,
        campaignCpl: campaignConversions > 0 ? campaignCost / campaignConversions : null,
        costRub,
      }

      await prisma.borisDirectLesson.create({
        data: {
          kind: 'group_economics',
          subjectType: 'adgroup',
          subjectId: adGroupId,
          text: buildGroupLessonText(signal, name, totals, confirmWeeks),
          evidence: {
            signal,
            weeks: weeks.map((week) => weekEvidence(week, week.byGroup.get(adGroupId))),
          } as Prisma.InputJsonValue,
          confidence: Math.min(0.9, 0.6 + 0.1 * confirmWeeks),
          weeksConfirmed: confirmWeeks,
        },
      })
      result.created += 1
    } catch (err) {
      console.error(`[boris-direct/lessons] урок по группе ${adGroupId} не создан:`, err)
    }
  }

  // ФАЗА 2б — новые уроки action_outcome по измеренным исходам improved/worse.
  const logs = await prisma.borisDirectActionLog.findMany({
    where: { outcomeVerdict: { in: ['improved', 'worse'] } },
    orderBy: { createdAt: 'asc' },
  })
  const busyActionSubjects = new Set(
    allLessons.filter((l) => l.subjectType === 'action' && l.subjectId).map((l) => l.subjectId)
  )
  for (const log of logs) {
    try {
      if (busyActionSubjects.has(log.id)) continue
      const verdict = log.outcomeVerdict as 'improved' | 'worse'
      await prisma.borisDirectLesson.create({
        data: {
          kind: 'action_outcome',
          subjectType: 'action',
          subjectId: log.id,
          text: buildActionLessonText(log.action, log.createdAt, verdict, log.outcomeData),
          evidence: {
            action: log.action,
            verdict,
            outcomeData: log.outcomeData,
          } as Prisma.InputJsonValue,
          confidence: verdict === 'worse' ? 0.7 : 0.6,
        },
      })
      result.created += 1
    } catch (err) {
      console.error(`[boris-direct/lessons] урок по действию ${log.id} не создан:`, err)
    }
  }

  return result
}

/** Перепроверка одного урока group_economics по последней полной неделе. */
async function recheckGroupLesson(
  lesson: BorisDirectLesson,
  lastWeek: WeekAggregates,
  now: Date,
  staleAgeMs: number,
  result: LessonsRefreshResult
): Promise<void> {
  const signal = evidenceSignal(lesson.evidence)
  const group = lesson.subjectId ? lastWeek.byGroup.get(lesson.subjectId) : undefined
  const weekSignal = groupWeekSignal(group, lastWeek)
  const lessonSide = signal ? signalSide(signal) : null
  const weekSide = signalSide(weekSignal)

  if (lessonSide && weekSide && weekSide === lessonSide) {
    // Сигнал подтвердился — урок живёт (STALE воскресает в ACTIVE).
    await prisma.borisDirectLesson.update({
      where: { id: lesson.id },
      data: {
        status: 'ACTIVE',
        weeksConfirmed: lesson.weeksConfirmed + 1,
        lastConfirmedAt: now,
        evidence: { signal, week: weekEvidence(lastWeek, group) } as Prisma.InputJsonValue,
      },
    })
    result.confirmed += 1
    return
  }

  if (lessonSide && weekSide && weekSide !== lessonSide) {
    // Сигнал развернулся при достаточных данных — урок опровергнут.
    await prisma.borisDirectLesson.update({
      where: { id: lesson.id },
      data: { status: 'REFUTED', refutedAt: now },
    })
    result.refuted += 1
    return
  }

  // Данных мало / сигнала нет: без подтверждения LESSON_STALE_WEEKS недель → STALE.
  const anchor = lesson.lastConfirmedAt ?? lesson.createdAt
  if (lesson.status === 'ACTIVE' && now.getTime() - anchor.getTime() > staleAgeMs) {
    await prisma.borisDirectLesson.update({
      where: { id: lesson.id },
      data: { status: 'STALE' },
    })
    result.staled += 1
  }
}

// ---------- Уроки в контекст промпта ----------

function freshnessMs(lesson: { lastConfirmedAt: Date | null; createdAt: Date }): number {
  return (lesson.lastConfirmedAt ?? lesson.createdAt).getTime()
}

/**
 * Топ-K ACTIVE-уроков для секции «ОПЫТ»: релевантные группам дня первыми,
 * затем по confidence и свежести; суммарная длина text не превышает
 * LESSON_BLOCK_MAX_CHARS (не влезший целиком урок отбрасывается).
 */
export async function getActiveLessonsForContext(opts?: {
  topK?: number
  relevantAdGroupIds?: string[]
}): Promise<LessonForContext[]> {
  const topK = opts?.topK ?? LESSON_TOP_K
  const relevant = new Set(opts?.relevantAdGroupIds ?? [])
  const lessons = await prisma.borisDirectLesson.findMany({ where: { status: 'ACTIVE' } })

  const sorted = [...lessons].sort((a, b) => {
    const relA = a.subjectId && relevant.has(a.subjectId) ? 0 : 1
    const relB = b.subjectId && relevant.has(b.subjectId) ? 0 : 1
    if (relA !== relB) return relA - relB
    if (a.confidence !== b.confidence) return b.confidence - a.confidence
    return freshnessMs(b) - freshnessMs(a)
  })

  const picked: LessonForContext[] = []
  let usedChars = 0
  for (const lesson of sorted.slice(0, topK)) {
    if (usedChars + lesson.text.length > LESSON_BLOCK_MAX_CHARS) continue
    picked.push({ id: lesson.id, kind: lesson.kind, text: lesson.text })
    usedChars += lesson.text.length
  }
  return picked
}

/** Детерминированная секция «ОПЫТ» для промпта (без LLM). */
export function formatLessonsBlock(lessons: LessonForContext[]): string {
  if (lessons.length === 0) return ''
  return ['ОПЫТ (мои проверенные уроки):', ...lessons.map((l) => `- ${l.text}`)].join('\n')
}

// ---------- Отчёт «Борис, что ты понял» ----------

const KIND_RU: Record<string, string> = {
  group_economics: 'экономика группы',
  action_outcome: 'исход действия',
}

/** Текст для команды владельца — код без LLM, без markdown-символов. */
export async function getActiveLessonsReport(): Promise<string> {
  const lessons = await prisma.borisDirectLesson.findMany()
  const active = lessons.filter((l) => l.status === 'ACTIVE')
  if (active.length === 0) {
    return 'Пока уроков нет — мало данных. Коплю историю по фразам и исходам действий, первые выводы появятся через пару недель работы кампании.'
  }

  const sorted = [...active].sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence
    return freshnessMs(b) - freshnessMs(a)
  })
  const lines = sorted.map((lesson, index) => {
    const kindRu = KIND_RU[lesson.kind] ?? lesson.kind
    const confirmed =
      lesson.weeksConfirmed > 0 ? `, подтверждён ${lesson.weeksConfirmed} нед.` : ''
    return `${index + 1}. ${lesson.text} (${kindRu}${confirmed})`
  })

  const staleCount = lessons.filter((l) => l.status === 'STALE').length
  const refutedCount = lessons.filter((l) => l.status === 'REFUTED').length
  if (staleCount > 0 || refutedCount > 0) {
    lines.push(`Устарело: ${staleCount}, опровергнуто: ${refutedCount}`)
  }
  return lines.join('\n')
}
