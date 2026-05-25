/**
 * Единая точка лейблов/цветов/описаний для ролей.
 *
 * 7.14A: добавлен ADMIN_PRO — он имеет ВСЕ права ADMIN (см. requireRole),
 * плюс эксклюзивные права на приёмку накладных, утверждение DRAFT-ингредиентов
 * и откат приёмок. Визуально отличается от ADMIN отдельным бейджем.
 *
 * До 7.14A копии ROLE_LABELS жили в navigation.ts и users-table.tsx — их
 * удалили, теперь всё импортируется отсюда.
 */

import type { UserRole } from '@prisma/client'

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN_PRO: 'Администратор PRO',
  ADMIN: 'Администратор',
  MANAGER: 'Менеджер',
  CHEF: 'Шеф',
  COURIER: 'Курьер',
}

// Tailwind 4 поставляет полную дефолтную палитру (violet/purple/etc.) рядом
// с нашими семантическими токенами — bg-accent/-fg/danger-bg/etc. Используем
// violet, потому что в проекте нет ни одного другого violet-элемента, что
// делает бейдж ADMIN_PRO мгновенно узнаваемым в таблице юзеров и сайдбаре.
// ADMIN остаётся красным (danger), как и был — обратная совместимость.
export const ROLE_COLORS: Record<UserRole, string> = {
  ADMIN_PRO: 'bg-violet-500/20 text-violet-700 dark:text-violet-300',
  ADMIN: 'bg-danger-bg text-danger-fg',
  MANAGER: 'bg-info-bg text-info-fg',
  CHEF: 'bg-warning-bg text-warning-fg',
  COURIER: 'bg-neutral-bg text-neutral-fg',
}

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  ADMIN_PRO:
    'Может принимать накладные, утверждать новые ингредиенты, откатывать приёмки',
  ADMIN: 'Полный доступ к управлению. Не принимает накладные.',
  MANAGER: 'Управляет клиентами и заказами',
  CHEF: 'Видит производство, не видит цены',
  COURIER: 'Видит только маршруты доставки',
}
