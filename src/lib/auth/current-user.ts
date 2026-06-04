import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { prisma } from '@/lib/db/prisma'
import { getSession } from './session'
import { getHomeForRole } from './roles'
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
    // П7: smart per-role redirect with a SELF-LOOP GUARD.
    //
    // The old fallback `redirect('/dashboard')` looped forever for roles that
    // cannot access /dashboard (COURIER, CHEF): they'd be sent to /dashboard,
    // fail its requireRole, and be sent back to /dashboard again.
    //
    // We now redirect to the role's own home. To avoid a NEW self-loop (the
    // role's home itself rejecting the role — e.g. a misconfiguration), we read
    // the current path from the `x-pathname` request header (set by proxy.ts)
    // and refuse to redirect to a home we're already on.
    const home = getHomeForRole(user.role)

    // headers() is async in Next 16. The header is forwarded as a *request*
    // header by proxy.ts via NextResponse.next({ request: { headers } }), so a
    // Server Component can read it here.
    const h = await headers()
    const currentPath = h.get('x-pathname') ?? ''

    const alreadyAtHome =
      currentPath === home ||
      currentPath.startsWith(`${home}?`) ||
      currentPath.startsWith(`${home}/`)

    if (alreadyAtHome) {
      // home itself rejected this role → redirecting to home would loop.
      console.warn('[require-role] self-loop avoided', {
        role: user.role,
        home,
        currentPath,
      })
      redirect('/login?reason=role-mismatch')
    }

    // If x-pathname is missing (proxy didn't run for this route, e.g. an
    // excluded path), currentPath is '' which can never equal a real home, so
    // `alreadyAtHome` is false and we safely redirect to home. This is the
    // preferred behavior per the spec: redirect(home) rather than bouncing to
    // /login, since home differs from the current (excluded) route family.
    redirect(home)
  }
  return user
}
