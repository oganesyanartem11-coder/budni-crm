import type { SalesTaskType } from '@prisma/client'
import { TASK_TYPE_RU } from '@/lib/sales/labels'

/**
 * Sprint 8.0 «Продажи»: мелкие чистые помощники UI воронки.
 */

const MINUTE_MS = 60 * 1000

/** Просрочена ли задача (как formatDueRelative: с первой полной минуты после срока). */
export function isOverdue(dueAt: Date | string, now: Date): boolean {
  const due = typeof dueAt === 'string' ? new Date(dueAt) : dueAt
  return now.getTime() - due.getTime() >= MINUTE_MS
}

/**
 * Подпись задачи: заголовок, а тип — только если заголовок свой
 * (по умолчанию title = TASK_TYPE_RU[type], дублировать не нужно).
 */
export function taskHeadline(task: { type: SalesTaskType; title: string }): {
  title: string
  typeLabel: string | null
} {
  const typeLabel = TASK_TYPE_RU[task.type]
  const title = task.title?.trim() || typeLabel
  return { title, typeLabel: title === typeLabel ? null : typeLabel }
}

/**
 * «12 000», «12000,50», «12 000 ₽» → число ≥ 0. Пусто → null.
 * Невалидно → undefined (показать ошибку).
 */
export function parseRubAmount(raw: string): number | null | undefined {
  const cleaned = raw.replace(/[\s₽]/g, '').replace(',', '.')
  if (cleaned === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined
  const value = Number(cleaned)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Целое число порций ≥ 0 из поля ввода. Пусто → null, невалидно → undefined. */
export function parsePortions(raw: string): number | null | undefined {
  const cleaned = raw.trim()
  if (cleaned === '') return null
  if (!/^\d{1,5}$/.test(cleaned)) return undefined
  return Number(cleaned)
}
