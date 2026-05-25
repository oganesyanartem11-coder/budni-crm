import type { InvoiceProgress } from '@prisma/client'

export const INVOICE_PROGRESS_LABELS: Record<InvoiceProgress, string> = {
  UPLOADED: 'Загружено',
  RECOGNIZING: 'Распознаём текст',
  MATCHING: 'Сопоставляем ингредиенты',
  READY: 'Готово',
  FAILED: 'Ошибка',
}

// Линейка этапов для progress-view. FAILED обрабатывается отдельно
// (как ошибка под списком этапов) — recognizer может упасть на любом
// этапе и сразу переходит в FAILED, не сохраняя где именно.
export const INVOICE_PROGRESS_STAGES: Array<{
  key: Exclude<InvoiceProgress, 'FAILED'>
  label: string
}> = [
  { key: 'UPLOADED', label: 'Загружено' },
  { key: 'RECOGNIZING', label: 'Распознаём текст' },
  { key: 'MATCHING', label: 'Сопоставляем ингредиенты' },
  { key: 'READY', label: 'Готово' },
]
