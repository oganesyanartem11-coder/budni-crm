/**
 * Недельный консилиум (М4 ШАГ 2). Раз в неделю heavy-модель получает ПОЛНЫЙ срез
 * недели (тренд по дням, пофразная экономика, три счётчика заявок, недорасход, доля
 * SYNONYM, уроки) и выдаёт владельцу 3–5 ГИПОТЕЗ.
 *
 * СТРОГО ТЕКСТ: гипотезы уходят разделом в недельный отчёт голосом Бориса, НЕ в
 * кабинет, НЕ предложениями-с-кнопками, НЕ действиями. Вся арифметика — код (числа
 * готовы, LLM их не пересчитывает). Fail-safe: LLM упал/таймаут/пусто → '' (недельный
 * отчёт уходит без секции консилиума, не блокируется).
 */

import { callBorisDirectLlm } from './llm'
import { getBorisDirectSystemPrompt } from './prompts'
import { getDirectRoleState } from './state'

export interface WeeklyConsiliumInput {
  period: { from: string; to: string }
  days: Array<{
    dateLabel: string
    spendRub: number | null
    clicks: number | null
    leadsFromDirect: number
    costPerLeadRub: number | null
  }>
  /** Пофразная экономика недели (клики/расход/конверсии). */
  topQueries: Array<{ query: string; clicks: number; costRub: number; conversions: number }>
  /** Три счётчика заявок недели (правда о заявках). */
  leadCounts: { directAttrib: number; metrika: number; delivered: number }
  underspendWeekly?: { medianSpendRub: number; dailyBudgetRub: number }
  matchTypeShare?: { synonymPct: number }
  /** Выжимка активных уроков (getActiveLessonsReport). */
  lessonsDigest?: string
}

const fmt = (n: number): string => String(Math.round(n))

/** Сколько фраз недели отдаём в срез (токен-бюджет). */
const CONSILIUM_MAX_QUERIES = 15

/** Детерминированный срез недели (вся арифметика — код). */
export function buildConsiliumDataBlock(input: WeeklyConsiliumInput): string {
  const lines: string[] = [`СРЕЗ НЕДЕЛИ ${input.period.from}…${input.period.to} (всё посчитано кодом):`]

  lines.push('', 'Дни (расход / клики / заявки Директ / цена заявки):')
  for (const d of input.days) {
    const spend = d.spendRub == null ? '?' : `${fmt(d.spendRub)} ₽`
    const cpl = d.costPerLeadRub == null ? '—' : `${fmt(d.costPerLeadRub)} ₽`
    lines.push(`- ${d.dateLabel}: ${spend} / ${d.clicks ?? 0} / ${d.leadsFromDirect} / ${cpl}`)
  }

  lines.push(
    '',
    `Заявки недели: Директ-атрибуция ${input.leadCounts.directAttrib}, Метрика ${input.leadCounts.metrika}, Доставлено ${input.leadCounts.delivered}`
  )

  if (input.topQueries.length > 0) {
    lines.push('', 'Фразы недели (клики / расход / конверсии):')
    for (const q of input.topQueries.slice(0, CONSILIUM_MAX_QUERIES)) {
      lines.push(`- «${q.query}»: ${q.clicks} / ${fmt(q.costRub)} ₽ / ${q.conversions}`)
    }
  }

  if (input.underspendWeekly) {
    lines.push(
      '',
      `Недорасход: медиана дневного расхода ${fmt(input.underspendWeekly.medianSpendRub)} ₽ при бюджете ${fmt(input.underspendWeekly.dailyBudgetRub)} ₽`
    )
  }
  if (input.matchTypeShare) {
    lines.push(`Доля SYNONYM-трафика: ${Math.round(input.matchTypeShare.synonymPct)}%`)
  }
  if (input.lessonsDigest && input.lessonsDigest.trim()) {
    lines.push('', 'Уроки:', input.lessonsDigest.trim())
  }

  return lines.join('\n')
}

const CONSILIUM_INSTRUCTION =
  'Ты — недельный консилиум Бориса. По этому срезу недели дай владельцу 3–5 ГИПОТЕЗ, что можно ' +
  'улучшить в кампании. Каждая гипотеза СТРОГО в формате: гипотеза → ожидаемый эффект (в заявках/на ' +
  'рубль) → цена проверки (что и как проверить дёшево). Это ТЕКСТ-размышление владельцу, а НЕ команды: ' +
  'ничего не применяй, в кабинет не пиши, кнопок не предлагай. Цифры бери только из данных, не выдумывай ' +
  'и не пересчитывай. Коротко, HTML для Telegram, без markdown. Начни заголовком «Консилиум недели».'

/**
 * Раздел консилиума для недельного отчёта. Всегда безопасна: любой сбой/пустой
 * ответ → '' (раздела нет, недельный отчёт уходит). Один heavy-вызов в неделю.
 */
export async function generateWeeklyConsilium(input: WeeklyConsiliumInput): Promise<string> {
  const dataBlock = buildConsiliumDataBlock(input)
  try {
    const state = await getDirectRoleState()
    const system = getBorisDirectSystemPrompt({ mode: state.mode, frozen: state.frozen })
    const result = await callBorisDirectLlm({
      purpose: 'weekly_consilium',
      tier: 'heavy',
      system,
      userText: `${CONSILIUM_INSTRUCTION}\n\n${dataBlock}`,
      maxTokens: 1400,
    })
    return result.text.trim()
  } catch (err) {
    console.error('[boris-direct/consilium] LLM недоступен — недельный отчёт уходит без консилиума', err)
    return ''
  }
}
