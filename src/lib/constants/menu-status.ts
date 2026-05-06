import type { MenuStatus } from '@prisma/client'

export const MENU_STATUS_LABELS: Record<MenuStatus, string> = {
  DRAFT: 'Черновик',
  APPROVED: 'Утверждено',
  ARCHIVED: 'Архив',
}

export const MENU_STATUS_VARIANT: Record<MenuStatus, 'success' | 'warning' | 'neutral'> = {
  DRAFT: 'warning',
  APPROVED: 'success',
  ARCHIVED: 'neutral',
}
