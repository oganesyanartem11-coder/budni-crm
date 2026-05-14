/**
 * Client-safe константы для optimistic-lock. Отдельный файл — чтобы клиентский
 * компонент мог импортировать сообщение без подтягивания prisma из server-only
 * src/lib/db/optimistic-lock.ts.
 */
export const OPTIMISTIC_LOCK_ERROR_MESSAGE =
  'Заказ изменён другим пользователем. Перезагрузите страницу.'

export function isOptimisticLockError(message: string): boolean {
  return message === OPTIMISTIC_LOCK_ERROR_MESSAGE
}
