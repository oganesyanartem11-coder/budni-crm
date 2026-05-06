'use server'

import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db/prisma'
import { isValidPinFormat, verifyPin } from '@/lib/auth/pin'
import { createSession, setSessionCookie, clearSessionCookie } from '@/lib/auth/session'

export type LoginResult =
  | { ok: true }
  | { ok: false; error: string }

export async function loginAction(pin: string): Promise<LoginResult> {
  // Валидация формата
  if (!isValidPinFormat(pin)) {
    return { ok: false, error: 'PIN должен состоять из 4 цифр' }
  }

  // Получаем всех активных пользователей и ищем подходящий PIN
  // (нельзя индексировать по PIN напрямую — он хранится в виде хэша)
  const users = await prisma.user.findMany({
    where: { isActive: true },
  })

  let matchedUser = null
  for (const user of users) {
    const isMatch = await verifyPin(pin, user.pinHash)
    if (isMatch) {
      matchedUser = user
      break
    }
  }

  if (!matchedUser) {
    // Тайминг-сейф: фиктивная проверка чтобы время отклика не выдавало наличие пользователя
    await verifyPin('0000', '$2a$10$invalidhashvaluetoslowdownX9X9X9X9X9X9X9X9X9X9X9X9X9X')
    return { ok: false, error: 'Неверный PIN' }
  }

  // Обновляем lastLoginAt
  await prisma.user.update({
    where: { id: matchedUser.id },
    data: { lastLoginAt: new Date() },
  })

  // Создаём сессию
  const token = await createSession({
    userId: matchedUser.id,
    role: matchedUser.role,
    name: matchedUser.name,
  })
  await setSessionCookie(token)

  return { ok: true }
}

export async function logoutAction(): Promise<void> {
  await clearSessionCookie()
  redirect('/login')
}
