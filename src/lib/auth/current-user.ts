import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db/prisma'
import { getSession } from './session'
import type { User, UserRole } from '@prisma/client'

/**
 * Возвращает текущего пользователя или редиректит на /login.
 * Используется в серверных компонентах внутри (app)/.
 */
export async function getCurrentUser(): Promise<User> {
  const session = await getSession()
  if (!session) {
    redirect('/login')
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
  })

  if (!user || !user.isActive) {
    redirect('/login')
  }

  return user
}

/**
 * Защищает маршрут от пользователей не из allowedRoles.
 */
export async function requireRole(allowedRoles: UserRole[]): Promise<User> {
  const user = await getCurrentUser()
  if (!allowedRoles.includes(user.role)) {
    redirect('/dashboard')
  }
  return user
}
