/**
 * ОТЧЁТЫ ПОЛИГОНА: свёртка ScenarioScore[] в матрицу policy×set и markdown.
 *
 * summarize/renderMarkdown — чистые функции (вход → детерминированный выход),
 * writeResults — единственное место с fs (раннер зовёт его со своим outDir).
 * Никакой сети/часов/Math.random.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CATEGORY_WEIGHTS,
  type CategoryKey,
  type MatrixSummary,
  type PolicyName,
  type ScenarioScore,
  type ScenarioSet,
} from '../types'

// ============================================================
// Пороги/константы отчёта
// ============================================================

/** В markdown-таблицу промахов попадает не больше стольких строк. */
const TOP_MISSES_LIMIT = 25
/** Знаков после запятой в таблицах (баллы и проценты). */
const TABLE_DECIMALS = 1

/** Порядок категорий в таблицах — как объявлены в CATEGORY_WEIGHTS (по убыванию веса). */
const CATEGORY_ORDER = Object.keys(CATEGORY_WEIGHTS) as CategoryKey[]

// ============================================================
// Математика (популяционная σ — прогонов мало, оцениваем сами прогоны)
// ============================================================

const round2 = (v: number): number => Math.round(v * 100) / 100
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length)
const std = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}

// ============================================================
// Свёртка в матрицу policy × set
// ============================================================

/** Группирует оценки по (policy, set) и усредняет; порядок групп детерминирован. */
export function summarize(scores: ScenarioScore[]): MatrixSummary[] {
  const groups = new Map<string, ScenarioScore[]>()
  for (const s of scores) {
    const key = `${s.policy}|${s.set}`
    const arr = groups.get(key) ?? []
    arr.push(s)
    groups.set(key, arr)
  }

  // Сортировка ключей — стабильный порядок строк в отчёте (policy, затем set).
  return [...groups.keys()].sort().map((key) => {
    const group = groups.get(key)!
    const [policy, set] = key.split('|') as [PolicyName, ScenarioSet]
    const totals = group.map((s) => s.total)

    const byCategory = {} as Record<CategoryKey, number>
    for (const cat of CATEGORY_ORDER) {
      // Каждый ScenarioScore из scoreRun несёт все категории; отсутствие = 0 (честнее, чем молча пропустить).
      byCategory[cat] = round2(mean(group.map((s) => s.categories.find((c) => c.key === cat)?.score ?? 0)))
    }

    return {
      policy,
      set,
      scenarios: new Set(group.map((s) => s.scenarioId)).size,
      seeds: new Set(group.map((s) => s.seed)).size,
      meanTotal: round2(mean(totals)),
      stdTotal: round2(std(totals)),
      byCategory,
      rightForWrongReasonPct: round2(mean(group.map((s) => s.rightForWrongReasonPct))),
      reliabilityTrips: group.filter((s) => s.reliabilityGateTripped).length,
    }
  })
}

// ============================================================
// Markdown-отчёт
// ============================================================

export interface RenderOptions {
  title: string
  /** Калибровочная линейка: summarize по ботам (lazy/random/greedy/oracle). */
  calibration?: MatrixSummary[]
  /** Худшие промахи для разбора ошибок (обрезаются до TOP_MISSES_LIMIT). */
  topMisses: Array<{ scenarioId: string; policy?: string; miss: string }>
}

/** Ячейка markdown-таблицы: экранируем вертикальную черту, чтобы не ломать разметку. */
const cell = (v: string): string => v.replace(/\|/g, '\\|')
const num = (v: number): string => v.toFixed(TABLE_DECIMALS)
const meanStd = (m: number, s: number): string => `${num(m)} ± ${num(s)}`

export function renderMarkdown(summaries: MatrixSummary[], opts: RenderOptions): string {
  const lines: string[] = [`# ${opts.title}`, '']

  // 1) Калибровочная линейка: политика → mean±std (санити-порядок lazy < ... < oracle).
  if (opts.calibration && opts.calibration.length > 0) {
    lines.push('## Калибровочная линейка', '')
    lines.push('| Политика | Сет | Сценариев | Зёрен | Total (mean ± std) |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const s of opts.calibration) {
      lines.push(`| ${s.policy} | ${s.set} | ${s.scenarios} | ${s.seeds} | ${meanStd(s.meanTotal, s.stdTotal)} |`)
    }
    lines.push('')
  }

  // 2) Категории по policy × set.
  lines.push('## Категории по policy × set', '')
  const catHeader = CATEGORY_ORDER.map((c) => `${c} (${CATEGORY_WEIGHTS[c]})`).join(' | ')
  lines.push(`| Политика | Сет | Сценариев | Зёрен | Total (mean ± std) | ${catHeader} | wrong-reason % | reliability trips |`)
  lines.push(`| --- | --- | --- | --- | --- | ${CATEGORY_ORDER.map(() => '---').join(' | ')} | --- | --- |`)
  for (const s of summaries) {
    const cats = CATEGORY_ORDER.map((c) => num(s.byCategory[c] ?? 0)).join(' | ')
    lines.push(
      `| ${s.policy} | ${s.set} | ${s.scenarios} | ${s.seeds} | ${meanStd(s.meanTotal, s.stdTotal)} | ${cats} | ${num(s.rightForWrongReasonPct)} | ${s.reliabilityTrips} |`,
    )
  }
  lines.push('')

  // 3) Топ-промахи — сырьё для разбора ошибок.
  lines.push(`## Топ-промахи (первые ${TOP_MISSES_LIMIT})`, '')
  if (opts.topMisses.length === 0) {
    lines.push('Промахов нет — либо всё идеально, либо матрица пуста.')
  } else {
    lines.push('| Сценарий | Политика | Промах |')
    lines.push('| --- | --- | --- |')
    for (const m of opts.topMisses.slice(0, TOP_MISSES_LIMIT)) {
      lines.push(`| ${cell(m.scenarioId)} | ${cell(m.policy ?? '—')} | ${cell(m.miss)} |`)
    }
    const rest = opts.topMisses.length - TOP_MISSES_LIMIT
    if (rest > 0) lines.push('', `… и ещё ${rest} за кадром (полный список — scores.json).`)
  }
  lines.push('')

  return lines.join('\n')
}

// ============================================================
// Запись результатов на диск
// ============================================================

/** Пишет scores.json + summaries.json + summary.md в dir (создаёт рекурсивно). */
export function writeResults(dir: string, scores: ScenarioScore[], summaries: MatrixSummary[], md: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'scores.json'), JSON.stringify(scores, null, 2), 'utf8')
  writeFileSync(join(dir, 'summaries.json'), JSON.stringify(summaries, null, 2), 'utf8')
  writeFileSync(join(dir, 'summary.md'), md, 'utf8')
}
