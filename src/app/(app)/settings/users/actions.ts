'use server'

import { randomBytes } from 'crypto'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { generateUniquePin, hashPin } from '@/lib/auth/pin'
import { getTelegramEnv } from '@/lib/telegram/env'
import type { UserRole } from '@prisma/client'

const ONBOARDING_TTL_MINUTES = 30
const DEFAULT_APP_BASE_URL = 'https://budni-crm.vercel.app'

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Администратор',
  MANAGER: 'Менеджер',
  CHEF: 'Шеф',
  COURIER: 'Курьер',
}

function appBaseUrl(): string {
  const v = process.env.TELEGRAM_APP_BASE_URL?.trim() || DEFAULT_APP_BASE_URL
  return v.replace(/\/$/, '')
}

function buildLoginUrl(): string {
  return `${appBaseUrl()}/login`
}

function buildMessageTemplate(input: {
  name: string
  role: UserRole
  pin: string | null
  deepLink: string | null
}): string {
  const lines: string[] = []
  lines.push(`Привет, ${input.name}!`)
  lines.push('')
  lines.push(`Тебя добавили в CRM «Будни» — роль: ${ROLE_LABELS[input.role]}.`)
  lines.push('')
  lines.push(`Вход: ${buildLoginUrl()}`)
  if (input.pin !== null) {
    lines.push(`PIN: ${input.pin}`)
  }
  if (input.deepLink !== null) {
    lines.push('')
    lines.push('Чтобы получать уведомления и сводки, открой бота:')
    lines.push(input.deepLink)
    lines.push('Ссылка действует 30 минут.')
  }
  return lines.join('\n')
}

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

const VALID_ROLES: UserRole[] = ['ADMIN', 'MANAGER', 'CHEF', 'COURIER']

export async function createUser(input: {
  name: string
  role: UserRole
  linkTelegram?: boolean
}): Promise<
  ActionResult<{
    id: string
    name: string
    role: UserRole
    pin: string
    loginUrl: string
    deepLink: string | null
    messageTemplate: string
  }>
> {
  await requireRole(['ADMIN'])

  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Имя обязательно' }
  if (name.length > 100) return { ok: false, error: 'Имя слишком длинное (макс. 100)' }
  if (!VALID_ROLES.includes(input.role)) return { ok: false, error: 'Неверная роль' }

  // Если запрошена привязка Telegram — валидируем env заранее, чтобы юзер
  // не создался в БД без рабочего deep-link'а.
  let botUsername: string | null = null
  if (input.linkTelegram) {
    try {
      botUsername = getTelegramEnv().botUsername
    } catch (e) {
      return { ok: false, error: `Telegram не настроен: ${(e as Error).message}` }
    }
  }

  let pin: string
  try {
    pin = await generateUniquePin()
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const pinHash = await hashPin(pin)

  let onboardingToken: string | null = null
  let onboardingExpiresAt: Date | null = null
  if (input.linkTelegram) {
    onboardingToken = randomBytes(24).toString('hex')
    onboardingExpiresAt = new Date(Date.now() + ONBOARDING_TTL_MINUTES * 60 * 1000)
  }

  const user = await prisma.user.create({
    data: {
      name,
      role: input.role,
      pinHash,
      telegramOnboardingToken: onboardingToken,
      telegramOnboardingExpiresAt: onboardingExpiresAt,
    },
  })

  const deepLink =
    onboardingToken && botUsername
      ? `https://t.me/${botUsername}?start=${onboardingToken}`
      : null
  const messageTemplate = buildMessageTemplate({
    name: user.name,
    role: user.role,
    pin,
    deepLink,
  })

  revalidatePath('/settings/users')
  return {
    ok: true,
    data: {
      id: user.id,
      name: user.name,
      role: user.role,
      pin,
      loginUrl: buildLoginUrl(),
      deepLink,
      messageTemplate,
    },
  }
}

export async function regenerateUserPin(
  userId: string
): Promise<ActionResult<{ pin: string }>> {
  await requireRole(['ADMIN'])

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!user) return { ok: false, error: 'Пользователь не найден' }

  let pin: string
  try {
    pin = await generateUniquePin()
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const pinHash = await hashPin(pin)

  await prisma.user.update({ where: { id: userId }, data: { pinHash } })

  revalidatePath('/settings/users')
  return { ok: true, data: { pin } }
}

export async function setUserActive(
  userId: string,
  isActive: boolean
): Promise<ActionResult> {
  const me = await requireRole(['ADMIN'])
  if (userId === me.id && !isActive) {
    return { ok: false, error: 'Нельзя отключить самого себя' }
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!user) return { ok: false, error: 'Пользователь не найден' }

  await prisma.user.update({ where: { id: userId }, data: { isActive } })

  revalidatePath('/settings/users')
  return { ok: true, data: undefined }
}

/**
 * Админ генерирует новый onboarding-токен для другого юзера. Перезаписывает
 * прежний токен и НЕ трогает уже привязанный chatId — старая привязка
 * продолжает работать до момента, когда юзер активирует новую ссылку (тогда
 * chatId перезапишется через @unique с конфликтом, если chat другой —
 * либо обновится тот же).
 */
export async function generateOnboardingTokenForUser(
  userId: string
): Promise<
  ActionResult<{
    name: string
    role: UserRole
    deepLink: string
    messageTemplate: string
    loginUrl: string
    expiresAt: string
  }>
> {
  const me = await requireRole(['ADMIN'])

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true, isActive: true },
  })
  if (!user) return { ok: false, error: 'Пользователь не найден' }
  if (!user.isActive) return { ok: false, error: 'Пользователь отключён' }

  let botUsername: string
  try {
    botUsername = getTelegramEnv().botUsername
  } catch (e) {
    return { ok: false, error: `Telegram не настроен: ${(e as Error).message}` }
  }

  const token = randomBytes(24).toString('hex')
  const expiresAt = new Date(Date.now() + ONBOARDING_TTL_MINUTES * 60 * 1000)

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        telegramOnboardingToken: token,
        telegramOnboardingExpiresAt: expiresAt,
      },
    }),
    prisma.activityLog.create({
      data: {
        userId: me.id,
        userRole: me.role,
        action: 'TELEGRAM_ONBOARDING_REISSUED',
        entityType: 'User',
        entityId: userId,
        payload: { targetUserId: userId, targetName: user.name },
      },
    }),
  ])

  const deepLink = `https://t.me/${botUsername}?start=${token}`
  const messageTemplate = buildMessageTemplate({
    name: user.name,
    role: user.role,
    pin: null,
    deepLink,
  })

  revalidatePath('/settings/users')
  return {
    ok: true,
    data: {
      name: user.name,
      role: user.role,
      deepLink,
      messageTemplate,
      loginUrl: buildLoginUrl(),
      expiresAt: expiresAt.toISOString(),
    },
  }
}

/**
 * Админ полностью отвязывает Telegram у другого юзера (chatId+username+token).
 */
export async function unlinkTelegramFromUser(
  userId: string
): Promise<ActionResult> {
  const me = await requireRole(['ADMIN'])

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      telegramChatId: true,
      telegramUsername: true,
    },
  })
  if (!user) return { ok: false, error: 'Пользователь не найден' }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        telegramChatId: null,
        telegramUsername: null,
        telegramOnboardingToken: null,
        telegramOnboardingExpiresAt: null,
      },
    }),
    prisma.activityLog.create({
      data: {
        userId: me.id,
        userRole: me.role,
        action: 'TELEGRAM_UNLINKED_BY_ADMIN',
        entityType: 'User',
        entityId: userId,
        payload: {
          targetUserId: userId,
          previousChatId: user.telegramChatId,
          previousUsername: user.telegramUsername,
        },
      },
    }),
  ])

  revalidatePath('/settings/users')
  return { ok: true, data: undefined }
}
