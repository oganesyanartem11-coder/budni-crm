'use client'

import { toast } from 'sonner'
import { isOptimisticLockError } from '@/lib/db/optimistic-lock-shared'

/**
 * Универсальный обработчик ошибок server-action: если это optimistic-lock
 * conflict — показывает toast с кнопкой «Обновить»; иначе — обычный error.
 * Возвращает true если был lock-конфликт, чтобы caller знал что не делать
 * дополнительных действий (например, не сбрасывать input).
 */
export function showActionError(error: string, onReload: () => void): boolean {
  if (isOptimisticLockError(error)) {
    toast.error(error, {
      duration: 8000,
      action: { label: 'Обновить', onClick: onReload },
    })
    return true
  }
  toast.error(error)
  return false
}
