/**
 * ВАЛИДАТОР ЗАЗЕМЛЕНИЯ (рассуждающий контур, спринт 14.07). ЧИСТЫЕ функции.
 *
 * Ядро анти-галлюцинации: каждое ЧИСЛО в выходе аналитика обязано встречаться во
 * ВХОДНОМ дашборде (единственный источник правды). Не встречается → находка
 * дропается (analyst-cycle логирует, вопрос не создаётся). Так heavy-модель не может
 * подсунуть выдуманную цифру («CPL взлетел до 340 ₽», когда 340 нет в данных).
 *
 * Допуски: округление (|Δ| ≤ 0.5) и относительный 2% — чтобы «7.96%» ↔ «8%» не
 * считалось выдумкой. Структурные малые целые 0..3 заземлены всегда (нумерация
 * гипотез, «0 заявок», «3 дня подряд») — они не несут фактических утверждений.
 */

/** Малые целые, дозволенные без явного присутствия (нумерация/счётчики/«ноль»). */
const STRUCTURAL = new Set([0, 1, 2, 3])

/** Абсолютный допуск (покрывает целочисленное округление). */
const ABS_TOL = 0.5
/** Относительный допуск (2%) — округление крупных величин. */
const REL_TOL = 0.02

/**
 * Все числовые токены строки: целые и дробные (десятичный разделитель — точка или
 * запятая). Проценты/₽/прочие суффиксы отбрасываются (берём голое число). Порядок
 * сохранён, дубликаты НЕ схлопываются (для полноты списка невалидных).
 */
export function extractNumbers(text: string): number[] {
  const out: number[] = []
  const re = /\d+(?:[.,]\d+)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[0].replace(',', '.'))
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/** Число заземлено, если совпадает (в допусках) с каким-то числом дашборда либо структурно. */
function grounded(value: number, dashboardNums: number[]): boolean {
  if (STRUCTURAL.has(value)) return true
  for (const d of dashboardNums) {
    const tol = Math.max(ABS_TOL, REL_TOL * Math.abs(d))
    if (Math.abs(value - d) <= tol) return true
  }
  return false
}

export interface GroundingResult {
  grounded: boolean
  /** Числа выхода, которых нет в дашборде (причина дропа). */
  ungrounded: number[]
}

/**
 * Проверить, что все числа `outputText` заземлены в `dashboardText`. grounded=false,
 * если хоть одно число выхода не найдено в дашборде (в допусках).
 */
export function validateGrounding(outputText: string, dashboardText: string): GroundingResult {
  const dashboardNums = extractNumbers(dashboardText)
  const ungrounded: number[] = []
  for (const v of extractNumbers(outputText)) {
    if (!grounded(v, dashboardNums)) ungrounded.push(v)
  }
  return { grounded: ungrounded.length === 0, ungrounded }
}
