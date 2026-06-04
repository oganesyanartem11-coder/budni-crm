'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { prisma } from '@/lib/db/prisma'
import { isValidPinFormat, verifyPin } from '@/lib/auth/pin'
import { hashPinLookup } from '@/lib/auth/pin-lookup'
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  revokeSession,
} from '@/lib/auth/session'
import type { UserRole } from '@prisma/client'

export type LoginResult =
  // P7: возвращаем role, чтобы клиент редиректил на home роли через
  // getHomeForRole (COURIER→/delivery, CHEF→/production), а не хардкодом на
  // /dashboard с лишним bounce через requireRole.
  | { ok: true; role: UserRole }
  | { ok: false; error: string }

// 7.9: global rate-limit. > N неудач за окно → блокируем все логины.
const RATE_LIMIT_WINDOW_MIN = 5
const RATE_LIMIT_MAX_FAILED = 20

// D1: per-user lockout — после N неудачных bcrypt-сверок подряд блокируем
// конкретного юзера на LOCKOUT_MIN минут. Срабатывает только если PIN был
// сопоставлен с user через pinLookupHash, но финальная bcrypt-сверка не
// прошла (т.е. мы знаем кого пытались логинить). Защищает от целевого
// brute-force одного аккаунта; глобальный rate-limit выше остаётся для
// brute-force разных PIN'ов.
const PER_USER_LOCKOUT_THRESHOLD = 5
const PER_USER_LOCKOUT_MIN = 15

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

  // 7.11: Fast path — HMAC-индекс по PIN'у даёт O(1) lookup вместо O(N×bcrypt).
  // pinLookupHash nullable: у юзеров, созданных до миграции 7.11, оно пусто и
  // догоняет лениво — после первого успешного slow-path-логина.
  type LoginUserFields = {
    id: string
    name: string
    role: import('@prisma/client').UserRole
    pinHash: string
    pinLookupHash: string | null
    loginLockedUntil: Date | null
  }
  const USER_SELECT = {
    id: true,
    name: true,
    role: true,
    pinHash: true,
    pinLookupHash: true,
    loginLockedUntil: true,
  } as const

  const lookup = hashPinLookup(pin)
  const fastCandidate = (await prisma.user.findFirst({
    where: { pinLookupHash: lookup, isActive: true },
    select: USER_SELECT,
  })) as LoginUserFields | null

  let matchedUser: LoginUserFields | null = null
  let usedFastPath = false
  // D1: если fastCandidate найден и уже под per-user lockout — отдаём то же
  // сообщение, что и для пройденной bcrypt-сверки в заблокированном состоянии
  // (ниже). Сохраняем флаг, всё равно жжём bcrypt для тайминг-симметрии, но
  // не инкрементируем счётчик и не пускаем дальше.
  let fastCandidateLocked = false

  if (fastCandidate) {
    if (
      fastCandidate.loginLockedUntil &&
      fastCandidate.loginLockedUntil.getTime() > Date.now()
    ) {
      // Тайминг-symmetry: всё равно выполняем bcrypt, чтобы lockout не
      // отличался по времени отклика от обычной проверки.
      await verifyPin(pin, fastCandidate.pinHash)
      fastCandidateLocked = true
    } else {
      // Lookup-индекс совпал, но всё равно подтверждаем bcrypt'ом: HMAC у нас
      // 64 бита (теоретическая коллизия ничтожна, но дешевле перестраховаться,
      // чем разбирать «логин чужим PIN'ом» в будущем).
      const isMatch = await verifyPin(pin, fastCandidate.pinHash)
      if (isMatch) {
        matchedUser = fastCandidate
        usedFastPath = true
      }
    }
  }

  // D1: fastCandidate под lockout — отвечаем тем же текстом, что и для
  // manual-lock ниже. Логируем как LOGIN_LOCKED_ATTEMPT для audit-трейла.
  if (fastCandidateLocked && fastCandidate) {
    const untilMsk = fastCandidate.loginLockedUntil!.toLocaleTimeString('ru-RU', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
    })
    await prisma.loginAttempt.create({ data: { success: false, ipAddress } })
    await prisma.activityLog.create({
      data: {
        userId: fastCandidate.id,
        userRole: fastCandidate.role,
        action: 'LOGIN_LOCKED_ATTEMPT',
        entityType: 'User',
        entityId: fastCandidate.id,
        payload: {
          lockedUntil: fastCandidate.loginLockedUntil!.toISOString(),
          ipAddress,
          reason: 'per_user_lockout',
        },
      },
    })
    return { ok: false, error: `Аккаунт заблокирован до ${untilMsk} МСК` }
  }

  // Slow path выполняем если fast не сработал ИЛИ если в БД остались юзеры
  // без pinLookupHash (естественная миграция: догоняем lookup после успеха).
  // Запрос count'а дешёвый — индекс по pinLookupHash покрывает condition.
  if (!matchedUser) {
    const usersMissingLookup = await prisma.user.count({
      where: { isActive: true, pinLookupHash: null },
    })

    if (usersMissingLookup > 0 || !fastCandidate) {
      const users = (await prisma.user.findMany({
        where: { isActive: true },
        select: USER_SELECT,
      })) as LoginUserFields[]

      for (const user of users) {
        // Если fastCandidate уже проверили — не делаем повторный bcrypt.
        if (fastCandidate && user.id === fastCandidate.id) continue
        const isMatch = await verifyPin(pin, user.pinHash)
        if (isMatch) {
          matchedUser = user
          break
        }
      }

      // Тайминг-safe: если на slow path юзеров не было (или все проверены без
      // совпадения) — выполняем фиктивный compare, чтобы пустая БД не отличалась
      // от полной по времени отклика.
      if (!matchedUser && users.length === 0) {
        await verifyPin(FAKE_PIN, FAKE_HASH)
      }
    }
  }

  // Lazy migration: успешный slow-path означает, что у юзера не было
  // pinLookupHash (или fastCandidate отдал коллизию по нему). Дописываем.
  if (matchedUser && !usedFastPath && matchedUser.pinLookupHash !== lookup) {
    await prisma.user.update({
      where: { id: matchedUser.id },
      data: { pinLookupHash: lookup },
    }).catch((e) => {
      // Если в той же гонке кто-то другой уже записал свой lookup и индекс
      // unique — просто логируем, не валим логин.
      console.error('[login] failed to backfill pinLookupHash:', e)
    })
  }

  if (!matchedUser) {
    // Тайминг-сейф: фиктивная проверка чтобы время отклика не выдавало наличие пользователя
    await verifyPin(FAKE_PIN, FAKE_HASH)
    // D1: per-user lockout. Если fastCandidate был найден (мы знаем кто
    // пытался), но bcrypt не прошёл — инкрементируем счётчик неудач на этом
    // user. При достижении PER_USER_LOCKOUT_THRESHOLD — ставим
    // loginLockedUntil. Если fastCandidate'а нет (PIN ни к кому не подошёл),
    // инкрементировать некого — глобальный rate-limit поверх это уже ловит.
    if (fastCandidate) {
      try {
        const updated = await prisma.user.update({
          where: { id: fastCandidate.id },
          data: { failedLoginAttempts: { increment: 1 } },
          select: { failedLoginAttempts: true },
        })
        if (updated.failedLoginAttempts >= PER_USER_LOCKOUT_THRESHOLD) {
          const lockUntil = new Date(Date.now() + PER_USER_LOCKOUT_MIN * 60 * 1000)
          await prisma.user.update({
            where: { id: fastCandidate.id },
            data: { loginLockedUntil: lockUntil },
          })
          await prisma.activityLog.create({
            data: {
              userId: fastCandidate.id,
              userRole: fastCandidate.role,
              action: 'LOGIN_AUTO_LOCKED',
              entityType: 'User',
              entityId: fastCandidate.id,
              payload: {
                attempts: updated.failedLoginAttempts,
                lockedUntil: lockUntil.toISOString(),
                lockMin: PER_USER_LOCKOUT_MIN,
                ipAddress,
              },
            },
          })
        }
      } catch (e) {
        // Не валим логин из-за проблем с инкрементом — это вспомогательная
        // защита, основной ответ всё равно «Неверный PIN». PIN/hash в лог
        // не попадают по дизайну.
        console.error('[login] failed to increment lockout counter')
        void e
      }
    }
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

  return { ok: true, role: matchedUser.role }
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
