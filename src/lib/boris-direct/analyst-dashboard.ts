/**
 * ДАШБОРД АНАЛИТИКА (рассуждающий контур, спринт 14.07). ЧИСТЫЙ сборщик компактного
 * среза кампании, который раз в день получает heavy-модель, чтобы поставить 0–3
 * ВОПРОСА дня. Все числа приходят снаружи уже посчитанными (из БД/снапшотов —
 * см. collectAnalystDashboard) — здесь только детерминированная вёрстка текста.
 *
 * ВАЖНО (заземление): этот текст — ЕДИНСТВЕННЫЙ источник правды для валидатора
 * (analyst-ground.ts). Любое число в ответе аналитика обязано встречаться здесь,
 * иначе находка дропается. Поэтому всё, что аналитику дозволено цитировать, должно
 * быть напечатано ниже. Токен-бюджет ~4k: списки урезаны сверху (top-N), строки терсе.
 */

import type { AnalystQuestion } from './questions'

/** Один день окна: расход/клики/заявки/цена заявки (CPL). */
export interface AnalystWindowDay {
  date: string
  /** Расход, ₽; null — неизвестен (печатаем «?», не выдумываем). */
  spendRub: number | null
  clicks: number
  leads: number
  /** Цена заявки, ₽; null при нуле заявок (не выдумываем деление на ноль). */
  cplRub: number | null
}

export interface AnalystDashboardInput {
  today: string
  mode: string
  frozen: boolean
  /** Блок 1: окно дневных итогов (ANALYST_DASHBOARD_WINDOW_DAYS дней). */
  window: { days: AnalystWindowDay[] }
  /**
   * Блок 1b: ЗВОНКИ (ручной приём, formType='phone_call') за окно — лиды БЕЗ рекламной
   * разметки, в дневной CPL/fromDirect не входят. Контекст против ложного нуля формы
   * («0 заявок» ≠ «нет лидов»). НЕ атрибуция: фразам не приписываются, в CPA не идут.
   */
  calls?: { windowCount: number }
  /** Блок 2: прогноз vs факт (готовая строка renderForecastLine) + последний слом. */
  forecast?: { line: string | null; lastBreak?: string }
  /** Блок 3: лесенка — медиана входа, доля ниже входа, дрейф за окно. */
  ladder?: {
    entryMedianRub: number | null
    belowEntryPct: number | null
    phrases: number
    driftMedianPct?: number | null
    driftBelowEntryPp?: number | null
  }
  /** Блок 4: гео/стройка-микс из QueryDailyStat (готовые строки). */
  mix?: { lines: string[] }
  /** Блок 5: статусы конвертеров/локов/якорей/гейтов/режима (готовые строки). */
  statuses?: { lines: string[] }
  /** Блок 6: агрегат вчерашних decisions (готовые строки). */
  decisions?: { lines: string[] }
  /** Блок 7: активные вопросы прошлых дней со статусами и результатами. */
  activeQuestions?: AnalystQuestion[]
  /** Блок 8: активные уроки (getActiveLessonsReport) + исходы действий. */
  lessons?: string
  outcomes?: string[]
  /** Блок 9: деньги — сделки/выручка (готовые строки). */
  money?: { lines: string[] }
  /** Блок 10 (прод): выходы детекторов дня. В ретро-реплее пусто (детекторов не было). */
  detectorAlerts?: string[]
  /** Блок 11: открытые гипотезы консилиума (kind='consilium'). */
  consilium?: string[]
}

/** Грубая оценка токенов (символы/4) — для отчёта/трима бюджета. */
export function estimateTokens(text: string): number {
  return Math.floor(text.length / 4)
}

const fmt = (n: number): string => String(Math.round(n))

/** Сколько строк списочных блоков максимум печатаем (токен-бюджет). */
const MAX_LIST = 12

function pushLines(out: string[], title: string, lines: string[] | undefined): void {
  if (!lines || lines.length === 0) return
  out.push('', title)
  for (const l of lines.slice(0, MAX_LIST)) out.push(`- ${l}`)
}

/**
 * Собрать текст дашборда. Каждая секция печатается ТОЛЬКО при наличии данных
 * (пустое → секции нет, аналитик не увидит и не сможет сослаться). Детерминизм:
 * одинаковый вход → байт-в-байт одинаковый выход.
 */
export function buildAnalystDashboard(input: AnalystDashboardInput): string {
  const out: string[] = []
  out.push(
    `ДАШБОРД АНАЛИТИКА за ${input.today} (всё посчитано кодом; режим ${input.mode}${input.frozen ? ', ЗАМОРОЗКА' : ''}).`
  )

  // --- Блок 1: окно дней (расход / клики / заявки / CPL) ---
  out.push('', 'ДНИ (день: расход ₽ / клики / заявки / цена заявки):')
  for (const d of input.window.days) {
    const cpl = d.cplRub == null ? '—' : `${fmt(d.cplRub)} ₽`
    const spend = d.spendRub == null ? '?' : `${fmt(d.spendRub)} ₽`
    out.push(`- ${d.date}: ${spend} / ${d.clicks} / ${d.leads} / ${cpl}`)
  }

  // --- Блок 1b: звонки (ручной приём, вне рекламной атрибуции) ---
  // Печатаем ТОЛЬКО при наличии (>0): «0 заявок по форме» + эта строка = сигнал
  // «лиды идут звонками, а не формой». НЕ приписывать фразам, НЕ считать в CPA.
  if (input.calls && input.calls.windowCount > 0) {
    out.push(
      '',
      `ЗВОНКИ (ручной приём, вне атрибуции; НЕ в CPA/фразы): ${input.calls.windowCount} за окно.`
    )
  }

  // --- Блок 2: прогноз ---
  if (input.forecast?.line) {
    out.push('', `ПРОГНОЗ/факт: ${input.forecast.line}`)
    if (input.forecast.lastBreak) out.push(`Последний слом: ${input.forecast.lastBreak}`)
  }

  // --- Блок 3: лесенка ---
  if (input.ladder) {
    const l = input.ladder
    const med = l.entryMedianRub == null ? 'нет' : `${fmt(l.entryMedianRub)} ₽`
    const below = l.belowEntryPct == null ? 'нет' : `${fmt(l.belowEntryPct)}%`
    const parts = [`медиана входа ${med}`, `ниже входа ${below}`, `фраз ${l.phrases}`]
    if (l.driftMedianPct != null) parts.push(`дрейф медианы ${fmt(l.driftMedianPct * 100)}%`)
    if (l.driftBelowEntryPp != null) parts.push(`дрейф ниже входа ${fmt(l.driftBelowEntryPp)} п.п.`)
    out.push('', `ЛЕСЕНКА: ${parts.join('; ')}.`)
  }

  // --- Блок 4: гео/стройка-микс ---
  pushLines(out, 'МИКС (гео/группы):', input.mix?.lines)

  // --- Блок 5: статусы ---
  pushLines(out, 'СТАТУСЫ (конвертеры/локи/якоря/гейты):', input.statuses?.lines)

  // --- Блок 6: вчерашние решения ---
  pushLines(out, 'РЕШЕНИЯ вчера:', input.decisions?.lines)

  // --- Блок 10 (прод): детекторы дня ---
  pushLines(out, 'ДЕТЕКТОРЫ дня:', input.detectorAlerts)

  // --- Блок 11: открытый консилиум ---
  pushLines(out, 'КОНСИЛИУМ (открытые гипотезы недели):', input.consilium)

  // --- Блок 7: активные вопросы прошлых дней ---
  if (input.activeQuestions && input.activeQuestions.length > 0) {
    out.push('', 'ВОПРОСЫ прошлых дней (статус — вопрос — результат проверки):')
    for (const q of input.activeQuestions.slice(0, MAX_LIST)) {
      const res = q.result ? ` → ${q.result}` : ' → (проверка не завершена)'
      out.push(`- [${q.status}] ${q.question}${res}`)
    }
  }

  // --- Блок 8: уроки + исходы ---
  if (input.lessons && input.lessons.trim()) {
    out.push('', 'УРОКИ (активные):', input.lessons.trim())
  }
  pushLines(out, 'ИСХОДЫ действий:', input.outcomes)

  // --- Блок 9: деньги ---
  pushLines(out, 'ДЕНЬГИ (сделки/выручка):', input.money?.lines)

  return out.join('\n')
}
