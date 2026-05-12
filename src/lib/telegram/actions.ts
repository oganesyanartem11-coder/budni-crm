'use server'

import { randomBytes } from 'crypto'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db/prisma'
import { getCurrentUser } from '@/lib/auth/current-user'
import { getTelegramEnv } from './env'

const ONBOARDING_TTL_MINUTES = 30

export interface GenerateTelegramOnboardingTokenResult {
  deeplink: string
  expiresAt: string // ISO, для удобства передачи в клиентский компонент
}

/**
 * Генерирует одноразовый onboarding-токен для текущего юзера,
 * сохраняет его в User вместе с TTL, и возвращает deeplink в Telegram.
 *
 * Перезапись существующего токена — это и есть «сгенерировать новую ссылку».
 */
export async function generateTelegramOnboardingToken(): Promise<GenerateTelegramOnboardingTokenResult> {
  const user = await getCurrentUser()
  const { botUsername } = getTelegramEnv()

  const token = randomBytes(24).toString('hex')
  const expiresAt = new Date(Date.now() + ONBOARDING_TTL_MINUTES * 60 * 1000)

  await prisma.user.update({
    where: { id: user.id },
    data: {
      telegramOnboardingToken: token,
      telegramOnboardingExpiresAt: expiresAt,
    },
  })

  revalidatePath('/settings/telegram')

  return {
    deeplink: `https://t.me/${botUsername}?start=${token}`,
    expiresAt: expiresAt.toISOString(),
  }
}

/**
 * Отвязка Telegram от текущего юзера. Чистит все 4 поля + пишет ActivityLog.
 */
export async function unlinkTelegram(): Promise<void> {
  const user = await getCurrentUser()

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        telegramChatId: null,
        telegramUsername: null,
        telegramOnboardingToken: null,
        telegramOnboardingExpiresAt: null,
      },
    }),
    prisma.activityLog.create({
      data: {
        userId: user.id,
        userRole: user.role,
        action: 'TELEGRAM_UNLINKED',
        entityType: 'User',
        entityId: user.id,
        payload: {
          previousChatId: user.telegramChatId,
          previousUsername: user.telegramUsername,
        },
      },
    }),
  ])

  revalidatePath('/settings/telegram')
}
