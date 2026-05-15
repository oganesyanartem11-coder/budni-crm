import type { MenuStatus } from '@prisma/client'

export const MENU_STATUS_LABELS: Record<MenuStatus, string> = {
  DRAFT: 'Черновик',
  PENDING_APPROVAL: 'На согласовании',
  APPROVED: 'Утверждено',
  ARCHIVED: 'Архив',
}

export const MENU_STATUS_VARIANT: Record<MenuStatus, 'success' | 'warning' | 'info' | 'neutral'> = {
  DRAFT: 'warning',
  PENDING_APPROVAL: 'info',
  APPROVED: 'success',
  ARCHIVED: 'neutral',
}
