/**
 * Светофор по марже-проценту:
 *  - > 40%  → зелёный (хорошо)
 *  - 20-40% → жёлтый (нормально)
 *  - < 20%  → красный (плохо)
 *  - null   → серый (нет данных о цене продажи)
 *
 * Tailwind токены — те же, что и в остальных финансовых блоках
 * (см. analytics-view, admin-week-block).
 */
export type MarginTone = 'green' | 'yellow' | 'red' | 'gray'

export function marginTone(marginPercent: number | null): MarginTone {
  if (marginPercent === null) return 'gray'
  if (marginPercent > 40) return 'green'
  if (marginPercent >= 20) return 'yellow'
  return 'red'
}

export const MARGIN_TONE_CLASSES: Record<MarginTone, string> = {
  green: 'bg-success-bg/40 text-success-fg',
  yellow: 'bg-warning-bg/40 text-warning-fg',
  red: 'bg-danger-bg/40 text-danger-fg',
  gray: 'bg-bg text-fg-muted',
}
