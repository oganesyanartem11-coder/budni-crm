import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { cookies } from 'next/headers'
import { prisma } from '@/lib/db/prisma'

const SESSION_COOKIE = 'budni_session'
const SESSION_DURATION_DAYS = 30
const SESSION_DURATION_MS = SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000

// 7.10: JWT хранит ТОЛЬКО sessionId. Все данные о юзере и реальная проверка
// revokedAt/expiresAt происходят в getCurrentUser через БД-lookup.
interface SessionPayload extends JWTPayload {
  sessionId: string
}

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET не задан в .env.local')
  }
  return new TextEncoder().encode(secret)
}

/**
 * Создаёт server-side Session-строку и подписывает JWT со ссылкой на её id.
 * IP/userAgent сохраняются для аудита (видно admin'у в будущем UI «активные сессии»).
 */
export async function createSession(
  userId: string,
  opts?: { ipAddress?: string | null; userAgent?: string | null }
): Promise<string> {
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS)
  const session = await prisma.session.create({
    data: {
      userId,
      expiresAt,
      ipAddress: opts?.ipAddress ?? null,
      userAgent: opts?.userAgent ?? null,
    },
  })

  return new SignJWT({ sessionId: session.id })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_DAYS}d`)
    .sign(getSecret())
}

/**
 * Stateless проверка JWT (без БД). Используется middleware (Edge) для быстрой
 * отсечки несекьюрных запросов. Реальный revoke-check — в getCurrentUser.
 */
export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ['HS256'],
    })
    if (typeof payload.sessionId !== 'string') return null
    return payload as SessionPayload
  } catch {
    return null
  }
}

/**
 * Помечает Session-строку revokedAt = now. JWT остаётся подписанным до своего
 * естественного exp, но getCurrentUser отвергнет любой запрос с этим sessionId.
 */
export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session
    .update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
    .catch(() => {
      // Session уже удалён cleanup-cron'ом или не существует — игнорируем.
    })
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE)
}

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null
  return verifySession(token)
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE
