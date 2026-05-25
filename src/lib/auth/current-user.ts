import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db/prisma'
import { getSession } from './session'
import type { User, UserRole } from '@prisma/client'

/**
 * Возвращает текущего пользователя или редиректит на /login.
 *
 * 7.10: проверяет server-side Session — отвергает revoked/expired токены
 * даже если JWT-подпись валидна. Это даёт возможность выгнать конкретный
 * cookie (compromised) через Session.revokedAt без ротации JWT_SECRET.
 */
export async function getCurrentUser(): Promise<User> {
  const cookie = await getSession()
  if (!cookie) {
    redirect('/login')
  }

  const session = await prisma.session.findUnique({
    where: { id: cookie.sessionId },
    include: { user: true },
  })

  if (!session) {
    redirect('/login')
  }
  if (session.revokedAt) {
    redirect('/login')
  }
  if (session.expiresAt.getTime() < Date.now()) {
    redirect('/login')
  }
  if (!session.user.isActive) {
    redirect('/login')
  }

  // best-effort lastUsedAt — не блокируем ответ при ошибке.
  prisma.session
    .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {})

  return session.user
}

/**
 * Защищает маршрут от пользователей не из allowedRoles.
 *
 * 7.14A: ADMIN_PRO автоматически наследует все права ADMIN — это даёт
 * возможность ввести новую роль, не правя 168 точек `requireRole(['ADMIN'])`
 * по проекту. Если в allowedRoles есть 'ADMIN', мы виртуально добавляем
 * 'ADMIN_PRO'. Если нужен строгий PRO-only маршрут (приёмка накладных) —
 * передавай `requireRole(['ADMIN_PRO'])` без 'ADMIN'.
 */
export async function requireRole(allowedRoles: UserRole[]): Promise<User> {
  const user = await getCurrentUser()
  const effective: UserRole[] = allowedRoles.includes('ADMIN')
    ? [...allowedRoles, 'ADMIN_PRO']
    : allowedRoles
  if (!effective.includes(user.role)) {
    redirect('/dashboard')
  }
  return user
}
