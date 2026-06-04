'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getCurrentUser } from '@/lib/auth/current-user'
import {
  verifyPin,
  isValidPinFormat,
  createPinFields,
} from '@/lib/auth/pin'

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * П5: любой залогиненный юзер меняет СОБСТВЕННЫЙ PIN.
 *
 * - currentPin сверяется bcrypt'ом через verifyPin (тот же primary-verify, что
 *   и логин). Никакого прямого bcrypt.compare — переиспользуем хелпер pin.ts.
 * - Формат нового PIN: ровно 4 цифры. Login-флоу (isValidPinFormat + 4-слотовая
 *   форма) принимает СТРОГО 4 цифры — 5-6-значный PIN залогинить нельзя, поэтому
 *   мы намеренно НЕ расширяем до /^\d{4,6}$/, иначе юзер сменит PIN и не войдёт.
 * - pinHash и pinLookupHash оба @unique → PIN глобально уникален. Коллизия
 *   (другой юзер уже занял этот PIN) ловится P2002 и отдаётся дружелюбной
 *   ошибкой вместо краша.
 * - После смены отзываем все активные сессии этого юзера (зеркало
 *   regenerateUserPin): старая JWT-сессия не должна переживать ротацию PIN.
 */
export async function changePin(
  currentPin: string,
  newPin: string
): Promise<ActionResult> {
  const me = await getCurrentUser()

  if (!isValidPinFormat(newPin)) {
    return { ok: false, error: 'Новый PIN должен состоять из 4 цифр' }
  }

  // Берём актуальный hash из БД (getCurrentUser возвращает полную модель User,
  // но читаем явно — на случай, если PIN сменили в другой вкладке).
  const user = await prisma.user.findUnique({
    where: { id: me.id },
    select: { id: true, pinHash: true },
  })
  if (!user) return { ok: false, error: 'Пользователь не найден' }

  const currentMatches = await verifyPin(currentPin, user.pinHash)
  if (!currentMatches) {
    return { ok: false, error: 'Текущий PIN неверный' }
  }

  if (currentPin === newPin) {
    return { ok: false, error: 'Новый PIN совпадает с текущим' }
  }

  const { pinHash, pinLookupHash } = await createPinFields(newPin)

  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: me.id },
        data: { pinHash, pinLookupHash },
      }),
      // Отзываем все остальные активные сессии — заставляем перелогиниться
      // новым PIN'ом (текущая сессия в этом списке тоже; getCurrentUser
      // редиректнет на /login при следующем запросе).
      prisma.session.updateMany({
        where: { userId: me.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      prisma.activityLog.create({
        data: {
          userId: me.id,
          userRole: me.role,
          action: 'PIN_CHANGED',
          entityType: 'User',
          entityId: me.id,
          payload: { userId: me.id },
        },
      }),
    ])
  } catch (e) {
    // pinHash/pinLookupHash @unique → P2002 при коллизии PIN'а с другим юзером.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      return {
        ok: false,
        error: 'Этот PIN уже занят. Выберите другой.',
      }
    }
    throw e
  }

  revalidatePath('/settings/profile')
  return { ok: true, data: undefined }
}
