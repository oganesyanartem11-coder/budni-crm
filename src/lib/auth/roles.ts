import type { UserRole } from '@prisma/client'

/**
 * П7: smart per-role redirect target ("home" route for a role).
 *
 * Used by requireRole's role-mismatch fallback and any place that needs to
 * send a user to the landing page appropriate for their role. Centralizing
 * this avoids the historical `redirect('/dashboard')` fallback that produced
 * an infinite self-loop for COURIER/CHEF (who cannot access /dashboard).
 */
export function getHomeForRole(role: UserRole): string {
  switch (role) {
    case 'COURIER':
      return '/delivery'
    case 'CHEF':
      return '/production'
    case 'ADMIN':
    case 'ADMIN_PRO':
    case 'MANAGER':
      return '/dashboard'
    default:
      return '/login'
  }
}
