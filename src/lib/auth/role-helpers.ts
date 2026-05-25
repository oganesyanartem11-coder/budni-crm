import type { UserRole } from '@prisma/client'

/**
 * Проверка что роль имеет права ADMIN-уровня.
 * ADMIN_PRO унаследовала все права ADMIN + эксклюзивные (приёмка накладных и т.п.).
 *
 * Используется в условном рендере JSX и для флагов canSeePrices/canEdit.
 * Для серверной защиты роутов используется requireRole(['ADMIN']) — она уже
 * включает ADMIN_PRO через extension в current-user.ts.
 *
 * При добавлении новых admin-like ролей — менять ТОЛЬКО эту функцию.
 */
export function isAdminLike(role: UserRole): boolean {
  return role === 'ADMIN' || role === 'ADMIN_PRO'
}

/**
 * Строгая проверка ADMIN_PRO — только PRO, без обычного ADMIN.
 * Используется для эксклюзивных action'ов (acceptInvoice, revertInvoice,
 * approveDraftIngredient).
 */
export function isAdminPro(role: UserRole): boolean {
  return role === 'ADMIN_PRO'
}
