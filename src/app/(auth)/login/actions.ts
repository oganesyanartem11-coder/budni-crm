'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { prisma } from '@/lib/db/prisma'
import { isValidPinFormat, verifyPin } from '@/lib/auth/pin'
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  revokeSession,
} from '@/lib/auth/session'

export type LoginResult =
  | { ok: true }
  | { ok: false; error: string }

// 7.9: global rate-limit. > N неудач за окно → блокируем все логины.
const RATE_LIMIT_WINDOW_MIN = 5
const RATE_LIMIT_MAX_FAILED = 20

// Тайминг-safe заглушка чтобы miss и rate-limit не отличались по времени от
// нормального match'а. Хэш заведомо невалидный, bcrypt.compare всё равно
// тратит ~100мс на свою работу.
const FAKE_PIN = '0000'
const FAKE_HASH = '$2a$10$invalidhashvaluetoslowdownX9X9X9X9X9X9X9X9X9X9X9X9X9X'

async function readIpAddress(): Promise<string | null> {
  const headersList = await headers()
  const forwardedFor = headersList.get('x-forwarded-for')
  return forwardedFor?.split(',')[0]?.trim() || null
}

async function readUserAgent(): Promise<string | null> {
  const headersList = await headers()
  return headersList.get('user-agent') || null
}

export async function loginAction(pin: string): Promise<LoginResult> {
  // Валидация формата
  if (!isValidPinFormat(pin)) {
    return { ok: false, error: 'PIN должен состоять из 4 цифр' }
  }

  const ipAddress = await readIpAddress()

  // 7.9: глобальный rate-limit. Считаем неудачи за последние RATE_LIMIT_WINDOW_MIN минут.
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60 * 1000)
  const recentFailed = await prisma.loginAttempt.count({
    where: { success: false, createdAt: { gte: windowStart } },
  })

  if (recentFailed >= RATE_LIMIT_MAX_FAILED) {
    // Тайминг-symmetry: всё равно жжём bcrypt чтобы ответ не был подозрительно быстрым.
    await verifyPin(FAKE_PIN, FAKE_HASH)
    await prisma.loginAttempt.create({ data: { success: false, ipAddress } })
    await prisma.activityLog.create({
      data: {
        userId: null,
        userRole: null,
        action: 'LOGIN_RATE_LIMITED',
        entityType: 'System',
        entityId: 'login',
        payload: { recentFailed, windowMin: RATE_LIMIT_WINDOW_MIN, ipAddress },
      },
    })
    return {
      ok: false,
      error: `Слишком много неудачных попыток. Подождите ${RATE_LIMIT_WINDOW_MIN} минут.`,
    }
  }

  // Получаем всех активных пользователей и ищем подходящий PIN
  // (нельзя индексировать по PIN напрямую — он хранится в виде хэша)
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      role: true,
      pinHash: true,
      loginLockedUntil: true,
    },
  })

  let matchedUser: (typeof users)[number] | null = null
  for (const user of users) {
    const isMatch = await verifyPin(pin, user.pinHash)
    if (isMatch) {
      matchedUser = user
      break
    }
  }

  if (!matchedUser) {
    // Тайминг-сейф: фиктивная проверка чтобы время отклика не выдавало наличие пользователя
    await verifyPin(FAKE_PIN, FAKE_HASH)
    await prisma.loginAttempt.create({ data: { success: false, ipAddress } })
    await prisma.activityLog.create({
      data: {
        userId: null,
        userRole: null,
        action: 'LOGIN_FAILED',
        entityType: 'System',
        entityId: 'login',
        payload: { ipAddress },
      },
    })
    return { ok: false, error: 'Неверный PIN' }
  }

  // Ручной ADMIN-lockout: PIN угадан, но юзер помечен заблокированным.
  if (matchedUser.loginLockedUntil && matchedUser.loginLockedUntil.getTime() > Date.now()) {
    const untilMsk = matchedUser.loginLockedUntil.toLocaleTimeString('ru-RU', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
    })
    await prisma.loginAttempt.create({ data: { success: false, ipAddress } })
    await prisma.activityLog.create({
      data: {
        userId: matchedUser.id,
        userRole: matchedUser.role,
        action: 'LOGIN_LOCKED_ATTEMPT',
        entityType: 'User',
        entityId: matchedUser.id,
        payload: { lockedUntil: matchedUser.loginLockedUntil.toISOString(), ipAddress },
      },
    })
    return { ok: false, error: `Аккаунт заблокирован до ${untilMsk} МСК` }
  }

  // Success: сбрасываем счётчики lockout, обновляем lastLoginAt.
  await prisma.user.update({
    where: { id: matchedUser.id },
    data: {
      failedLoginAttempts: 0,
      loginLockedUntil: null,
      lastLoginAt: new Date(),
    },
  })

  await prisma.loginAttempt.create({ data: { success: true, ipAddress } })
  await prisma.activityLog.create({
    data: {
      userId: matchedUser.id,
      userRole: matchedUser.role,
      action: 'LOGIN_SUCCESS',
      entityType: 'User',
      entityId: matchedUser.id,
      payload: { ipAddress },
    },
  })

  // Создаём server-side Session (7.10) и JWT со ссылкой на её id.
  const userAgent = await readUserAgent()
  const token = await createSession(matchedUser.id, { ipAddress, userAgent })
  await setSessionCookie(token)

  return { ok: true }
}

export async function logoutAction(): Promise<void> {
  // 7.10: помечаем Session revokedAt, чтобы любые ещё подписанные JWT
  // с этим sessionId тоже отвергались getCurrentUser.
  const cookie = await getSession()
  if (cookie?.sessionId) {
    await revokeSession(cookie.sessionId)
  }
  await clearSessionCookie()
  redirect('/login')
}
