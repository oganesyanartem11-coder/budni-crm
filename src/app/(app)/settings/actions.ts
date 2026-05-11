'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db/prisma'
import { getCurrentUser } from '@/lib/auth/current-user'
import { generateOnboardingToken, buildOnboardingDeeplink } from '@/lib/bot/onboarding'

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * Возвращает (или генерирует впервые) onboarding-токен и deep-link для текущего user'а.
 */
export async function ensureMyOnboardingToken(): Promise<
  ActionResult<{ token: string; deeplink: string }>
> {
  const user = await getCurrentUser()

  let token = user.maxOnboardingToken
  if (!token) {
    token = generateOnboardingToken()
    await prisma.user.update({
      where: { id: user.id },
      data: { maxOnboardingToken: token },
    })
  }

  revalidatePath('/settings')
  return { ok: true, data: { token, deeplink: buildOnboardingDeeplink(token) } }
}

/**
 * Отвязывает MAX от моего аккаунта (для повторного онбординга).
 */
export async function unbindMyMaxChat(): Promise<ActionResult> {
  const user = await getCurrentUser()
  await prisma.user.update({
    where: { id: user.id },
    data: { maxChatId: null, onboardedAt: null },
  })
  revalidatePath('/settings')
  return { ok: true, data: undefined }
}
