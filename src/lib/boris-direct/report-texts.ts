/**
 * Тексты отчётов роли «трафик» (Борис-Директ): дневной, недельный, месячный
 * + сообщения об аномалиях.
 *
 * Принцип гибрида: ВСЯ арифметика (суммы, средние, динамика недель,
 * форматирование чисел) — код в этом модуле; LLM получает готовый
 * детерминированный блок цифр и только пересказывает его голосом Бориса,
 * менять цифры запрещено промптом. Ошибка LLM НЕ роняет отчёт — уходит
 * сырой блок с шапкой-фолбэком. Аномалии форматируются вообще без LLM:
 * они обязаны дойти до владельца, даже когда Anthropic лежит.
 */

import type { DailyReportData } from './brain'
import type { Anomaly } from './anomalies'
import { callBorisDirectLlm } from './llm'
import { getBorisDirectSystemPrompt } from './prompts'
import { getDirectRoleState } from './state'
import { getActiveLessonsForContext, formatLessonsBlock } from './lessons'

const DAY_MS = 24 * 60 * 60 * 1000

// ---------- Форматирование чисел (только код, LLM цифры не трогает) ----------

/** Рубли без копеек; null → «нет данных». */
function formatRub(value: number | null): string {
  return value === null ? 'нет данных' : `${Math.round(value)} ₽`
}

function formatCount(value: number | null): string {
  return value === null ? 'нет данных' : String(value)
}

/** CTR с двумя знаками после запятой; null → «нет данных». */
function formatCtr(value: number | null): string {
  return value === null ? 'нет данных' : `${value.toFixed(2)}%`
}

function formatBulletList(items: string[], emptyLabel: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : emptyLabel
}

// ---------- Аномалии (детерминированно, БЕЗ LLM) ----------

/** «🚨» critical / «⚠️» warn + текст. Без LLM — алёрт уходит всегда. */
export function formatAnomalyMessage(a: Anomaly): string {
  return `${a.severity === 'critical' ? '🚨' : '⚠️'} ${a.text}`
}

// ---------- Общая LLM-обвязка отчётов ----------

/**
 * Пересказ детерминированного блока цифр голосом Бориса (heavy).
 * Ошибка/пустой ответ LLM → фолбэк: сырой блок с шапкой (отчёт обязан уйти).
 */
async function narrate(opts: {
  purpose: string
  critical: boolean
  instruction: string
  dataBlock: string
  fallbackHeader: string
}): Promise<string> {
  try {
    const state = await getDirectRoleState()
    const result = await callBorisDirectLlm({
      purpose: opts.purpose,
      tier: 'heavy',
      critical: opts.critical,
      system: getBorisDirectSystemPrompt({ mode: state.mode, frozen: false }),
      userText: `${opts.instruction}\n\n${opts.dataBlock}`,
    })
    const text = result.text.trim()
    if (text.length > 0) return text
    console.error(`[boris-direct/report-texts] LLM «${opts.purpose}» вернул пустой текст — фолбэк`)
  } catch (err) {
    console.error(
      `[boris-direct/report-texts] LLM для «${opts.purpose}» недоступен — отчёт уходит сырым блоком`,
      err
    )
  }
  return `${opts.fallbackHeader}\n\n${opts.dataBlock}`
}

// ---------- Дневной отчёт ----------

export interface DailyReportInput {
  data: DailyReportData
  appliedSummaries: string[]
  wouldDoSummaries: string[]
  proposalsCreated: string[]
  anomalies: string[]
  observe: boolean
  /**
   * Сколько алёртов Борис УЖЕ отправил за сегодня отдельными сообщениями
   * (collect/process). Тексты в дневной сводке не дублируем, но если алёрты
   * БЫЛИ (>0), сводка на них ССЫЛАЕТСЯ («утром было N …»), а НЕ пишет
   * «аномалий нет» — иначе вечерняя сводка противоречит утренним алёртам.
   */
  anomaliesFiredToday?: number
  /** Готовая секция «ОПЫТ» (formatLessonsBlock). Пусто/undefined → секции нет;
   * undefined в generateDailyReportText → уроки подтягиваются сами. */
  lessonsBlock?: string
}

/** Русская форма слова «алерт» по числу: 1 алерт, 2 алерта, 5 алертов. */
function pluralAlert(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'алерт'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'алерта'
  return 'алертов'
}

/**
 * Секция аномалий дневной сводки. Тексты уже ушли ОТДЕЛЬНЫМИ сообщениями из
 * collect/process — в сводке ссылка, а не дубль. Если за сегодня были алёрты
 * (anomaliesFiredToday>0), сводка на них СОШЛЁТСЯ, а не напишет «нет».
 */
function anomaliesSection(input: DailyReportInput): string {
  if (input.anomalies.length > 0) return formatBulletList(input.anomalies, 'нет')
  const n = input.anomaliesFiredToday ?? 0
  if (n > 0) return `утром было ${n} ${pluralAlert(n)}`
  return 'нет'
}

/** Детерминированный блок цифр дневного отчёта (вся арифметика уже сделана). */
export function buildDailyDataBlock(input: DailyReportInput): string {
  const d = input.data
  const topQueries =
    d.topQueries.length > 0
      ? d.topQueries
          .map(
            (q) =>
              `- «${q.query}»: ${q.clicks} кликов, ${Math.round(q.costRub)} ₽, конверсий ${q.conversions}`
          )
          .join('\n')
      : 'нет данных'

  const lines = [
    `Дневной отчёт за ${d.dateLabel}`,
    `Режим: ${input.observe ? 'наблюдение (в Директ не пишу)' : 'боевой'}`,
    `Карантин: ${d.quarantine ? 'да — не оптимизирую, наблюдаю' : 'нет'}`,
    '',
    'ЦИФРЫ ЗА ВЧЕРА (посчитаны кодом):',
    `- Расход: ${formatRub(d.spendRub)}`,
    `- Показы: ${formatCount(d.impressions)}`,
    `- Клики: ${formatCount(d.clicks)}`,
    `- CTR: ${formatCtr(d.ctr)}`,
    `- Заявок всего: ${d.leadsTotal}, из Директа: ${d.leadsFromDirect}`,
    `- Цена заявки: ${formatRub(d.costPerLeadRub)}`,
    '',
    'ТОП-ЗАПРОСЫ:',
    topQueries,
    '',
    'ЧТО СДЕЛАЛ:',
    formatBulletList(input.appliedSummaries, 'ничего'),
    'ЧТО СДЕЛАЛ БЫ (не применено — режим наблюдения/стоп-кран):',
    formatBulletList(input.wouldDoSummaries, 'ничего'),
    'ПРЕДЛОЖЕНИЯ ВЛАДЕЛЬЦУ:',
    formatBulletList(input.proposalsCreated, 'нет'),
    'АНОМАЛИИ (уже отправлены отдельными сообщениями):',
    anomaliesSection(input),
  ]

  // Секция «ОПЫТ» — только если блок уроков непустой (никаких пустых заголовков).
  if (input.lessonsBlock && input.lessonsBlock.trim().length > 0) {
    lines.push('', input.lessonsBlock)
  }

  return lines.join('\n')
}

/** Текст дневного отчёта: LLM пересказывает блок цифр, фолбэк — сырой блок. */
export async function generateDailyReportText(input: DailyReportInput): Promise<string> {
  // Секцию «ОПЫТ» подтягиваем сами, если вызывающий не передал готовый блок.
  // Ошибка уроков не роняет отчёт — просто без секции.
  let lessonsBlock = input.lessonsBlock
  if (lessonsBlock === undefined) {
    try {
      lessonsBlock = formatLessonsBlock(await getActiveLessonsForContext())
    } catch (err) {
      console.error('[boris-direct/report-texts] уроки для дневного отчёта не получены', err)
      lessonsBlock = ''
    }
  }
  return narrate({
    purpose: 'daily_report',
    critical: false,
    instruction:
      'Перескажи владельцу дневной отчёт по этим данным. Коротко, HTML для Telegram, цифры НЕ менять и НЕ пересчитывать. Если в данных есть секция ОПЫТ — можешь сослаться на свои уроки, но не выдумывай новых.',
    dataBlock: buildDailyDataBlock({ ...input, lessonsBlock }),
    fallbackHeader: '📊 Дневной отчёт (без обработки — LLM недоступен)',
  })
}

// ---------- Недельный отчёт ----------

export interface WeeklyReportExtras {
  llmSpendUsd: number
  llmCalls: number
  proposalsPending: number
  /** Итог еженедельной дистилляции уроков (если она была на этой неделе). */
  lessonsSummary?: { created: number; confirmed: number; refuted: number; staled: number }
}

/** Агрегат по запросу за период (суммы по дням, где запрос попал в топ). */
interface QueryAggregate {
  clicks: number
  costRub: number
  conversions: number
}

function aggregateQueries(days: DailyReportData[]): Map<string, QueryAggregate> {
  const byQuery = new Map<string, QueryAggregate>()
  for (const day of days) {
    for (const q of day.topQueries) {
      const agg = byQuery.get(q.query) ?? { clicks: 0, costRub: 0, conversions: 0 }
      agg.clicks += q.clicks
      agg.costRub += q.costRub
      agg.conversions += q.conversions
      byQuery.set(q.query, agg)
    }
  }
  return byQuery
}

/** Детерминированный блок цифр недельного отчёта (тренды считает код). */
export function buildWeeklyDataBlock(days: DailyReportData[], extras: WeeklyReportExtras): string {
  const sorted = [...days].sort((a, b) => a.dateLabel.localeCompare(b.dateLabel))
  const spendRub = sorted.reduce((acc, d) => acc + (d.spendRub ?? 0), 0)
  const clicks = sorted.reduce((acc, d) => acc + (d.clicks ?? 0), 0)
  const impressions = sorted.reduce((acc, d) => acc + (d.impressions ?? 0), 0)
  const leadsTotal = sorted.reduce((acc, d) => acc + d.leadsTotal, 0)
  const leadsFromDirect = sorted.reduce((acc, d) => acc + d.leadsFromDirect, 0)
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null
  const costPerLead = leadsFromDirect > 0 ? spendRub / leadsFromDirect : null

  const dayLines = sorted.map(
    (d) =>
      `- ${d.dateLabel}: расход ${formatRub(d.spendRub)}, кликов ${formatCount(d.clicks)}, ` +
      `заявок из Директа ${d.leadsFromDirect}, цена заявки ${formatRub(d.costPerLeadRub)}` +
      (d.quarantine ? ' (карантин)' : '')
  )

  // Лучшие — с конверсиями (по убыванию), худшие — расход без единой конверсии.
  const entries = [...aggregateQueries(sorted).entries()]
  const best = entries
    .filter(([, s]) => s.conversions > 0)
    .sort((a, b) => b[1].conversions - a[1].conversions || b[1].clicks - a[1].clicks)
    .slice(0, 3)
    .map(
      ([query, s]) =>
        `- «${query}»: конверсий ${s.conversions}, ${s.clicks} кликов, ${Math.round(s.costRub)} ₽`
    )
  const worst = entries
    .filter(([, s]) => s.conversions === 0)
    .sort((a, b) => b[1].costRub - a[1].costRub)
    .slice(0, 3)
    .map(([query, s]) => `- «${query}»: 0 конверсий, ${s.clicks} кликов, ${Math.round(s.costRub)} ₽`)

  return [
    `Недельный отчёт (дней с данными: ${sorted.length})`,
    '',
    'ИТОГИ НЕДЕЛИ (посчитаны кодом):',
    `- Расход: ${formatRub(spendRub)}`,
    `- Показы: ${formatCount(impressions)}`,
    `- Клики: ${formatCount(clicks)}`,
    `- CTR: ${formatCtr(ctr)}`,
    `- Заявок всего: ${leadsTotal}, из Директа: ${leadsFromDirect}`,
    `- Средняя цена заявки: ${formatRub(costPerLead)}`,
    '',
    'ДИНАМИКА ПО ДНЯМ:',
    dayLines.length > 0 ? dayLines.join('\n') : 'данных за неделю нет',
    '',
    'ЛУЧШИЕ ЗАПРОСЫ (есть конверсии):',
    best.length > 0 ? best.join('\n') : 'нет',
    'ХУДШИЕ ЗАПРОСЫ (расход без конверсий):',
    worst.length > 0 ? worst.join('\n') : 'нет',
    '',
    // Итог дистилляции уроков — детерминированно, кодом (не LLM).
    ...(extras.lessonsSummary
      ? [
          `Уроки за неделю: новых ${extras.lessonsSummary.created}, подтверждено ${extras.lessonsSummary.confirmed}, опровергнуто ${extras.lessonsSummary.refuted}, устарело ${extras.lessonsSummary.staled}`,
        ]
      : []),
    `Предложений без ответа владельца: ${extras.proposalsPending}`,
    `Стоимость аналитики за неделю (отдельные деньги, не рекламный бюджет): ~${extras.llmSpendUsd.toFixed(2)} $ / ${extras.llmCalls} обращений к LLM`,
  ].join('\n')
}

/** Текст недельного отчёта: LLM пересказывает тренды, фолбэк — сырой блок. */
export async function generateWeeklyReportText(
  days: DailyReportData[],
  extras: WeeklyReportExtras
): Promise<string> {
  return narrate({
    purpose: 'weekly_report',
    critical: false,
    instruction:
      'Перескажи владельцу недельный отчёт по этим данным: итоги, динамика по дням, лучшие и худшие запросы. Коротко, HTML для Telegram, цифры НЕ менять и НЕ пересчитывать.',
    dataBlock: buildWeeklyDataBlock(days, extras),
    fallbackHeader: '📊 Недельный отчёт (без обработки — LLM недоступен)',
  })
}

// ---------- Месячный отчёт ----------

export interface MonthlyReportExtras {
  llmSpendUsd: number
  llmCalls: number
  monthLabel: string
}

/** Понедельник МСК-недели даты 'YYYY-MM-DD' (ключ группировки по неделям). */
function mondayOf(dateLabel: string): string {
  const date = new Date(`${dateLabel}T00:00:00Z`)
  const shift = (date.getUTCDay() + 6) % 7
  return new Date(date.getTime() - shift * DAY_MS).toISOString().slice(0, 10)
}

/** Детерминированный блок цифр месячного отчёта: итог + цена заявки по неделям. */
export function buildMonthlyDataBlock(
  days: DailyReportData[],
  extras: MonthlyReportExtras
): string {
  const sorted = [...days].sort((a, b) => a.dateLabel.localeCompare(b.dateLabel))
  const spendRub = sorted.reduce((acc, d) => acc + (d.spendRub ?? 0), 0)
  const clicks = sorted.reduce((acc, d) => acc + (d.clicks ?? 0), 0)
  const impressions = sorted.reduce((acc, d) => acc + (d.impressions ?? 0), 0)
  const leadsTotal = sorted.reduce((acc, d) => acc + d.leadsTotal, 0)
  const leadsFromDirect = sorted.reduce((acc, d) => acc + d.leadsFromDirect, 0)
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null
  const costPerLead = leadsFromDirect > 0 ? spendRub / leadsFromDirect : null

  // Динамика цены заявки по неделям (неделя = с понедельника).
  const weeks = new Map<string, { spendRub: number; leadsFromDirect: number }>()
  for (const day of sorted) {
    const key = mondayOf(day.dateLabel)
    const agg = weeks.get(key) ?? { spendRub: 0, leadsFromDirect: 0 }
    agg.spendRub += day.spendRub ?? 0
    agg.leadsFromDirect += day.leadsFromDirect
    weeks.set(key, agg)
  }
  const weekLines = [...weeks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monday, w]) => {
      const cpl = w.leadsFromDirect > 0 ? w.spendRub / w.leadsFromDirect : null
      return `- неделя с ${monday}: расход ${formatRub(w.spendRub)}, заявок из Директа ${w.leadsFromDirect}, цена заявки ${formatRub(cpl)}`
    })

  return [
    `Месячный отчёт: ${extras.monthLabel} (дней с данными: ${sorted.length})`,
    '',
    'ИТОГ МЕСЯЦА (посчитан кодом):',
    `- Расход: ${formatRub(spendRub)}`,
    `- Показы: ${formatCount(impressions)}`,
    `- Клики: ${formatCount(clicks)}`,
    `- CTR: ${formatCtr(ctr)}`,
    `- Заявок всего: ${leadsTotal}, из Директа: ${leadsFromDirect}`,
    `- Средняя цена заявки: ${formatRub(costPerLead)}`,
    '',
    'ДИНАМИКА ЦЕНЫ ЗАЯВКИ ПО НЕДЕЛЯМ:',
    weekLines.length > 0 ? weekLines.join('\n') : 'данных за месяц нет',
  ].join('\n')
}

/**
 * Текст месячного отчёта (heavy, critical — не деградирует на light).
 * Строка про деньги на аналитику ВСЕГДА добавляется кодом в конце —
 * LLM её не формулирует и не может потерять.
 */
export async function generateMonthlyReportText(
  days: DailyReportData[],
  extras: MonthlyReportExtras
): Promise<string> {
  const text = await narrate({
    purpose: 'monthly_report',
    critical: true,
    instruction:
      'Перескажи владельцу итог месяца по этим данным: результат, динамика цены заявки по неделям, главный вывод. Коротко, HTML для Telegram, цифры НЕ менять и НЕ пересчитывать. Про стоимость аналитики (LLM) НЕ пиши — эту строку добавит код.',
    dataBlock: buildMonthlyDataBlock(days, extras),
    fallbackHeader: '📊 Месячный отчёт (без обработки — LLM недоступен)',
  })
  return (
    `${text}\n\n💰 На аналитику потрачено ~${extras.llmSpendUsd.toFixed(2)} $ / ` +
    `${extras.llmCalls} обращений к LLM — это отдельные деньги, не рекламный бюджет.`
  )
}
