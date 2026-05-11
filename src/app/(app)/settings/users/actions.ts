'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { generateUniquePin, hashPin } from '@/lib/auth/pin'
import type { UserRole } from '@prisma/client'

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

const VALID_ROLES: UserRole[] = ['ADMIN', 'MANAGER', 'CHEF', 'COURIER']

export async function createUser(input: {
  name: string
  role: UserRole
}): Promise<ActionResult<{ id: string; name: string; role: UserRole; pin: string }>> {
  await requireRole(['ADMIN'])

  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Имя обязательно' }
  if (name.length > 100) return { ok: false, error: 'Имя слишком длинное (макс. 100)' }
  if (!VALID_ROLES.includes(input.role)) return { ok: false, error: 'Неверная роль' }

  let pin: string
  try {
    pin = await generateUniquePin()
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const pinHash = await hashPin(pin)

  const user = await prisma.user.create({
    data: { name, role: input.role, pinHash },
  })

  revalidatePath('/settings/users')
  return {
    ok: true,
    data: { id: user.id, name: user.name, role: user.role, pin },
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
