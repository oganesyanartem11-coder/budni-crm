'use server'

import { revalidatePath } from 'next/cache'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'

export interface ActionResult {
  ok: boolean
  error?: string
}

export async function resolveError(id: string): Promise<ActionResult> {
  const me = await requireRole(['ADMIN'])

  const existing = await prisma.errorLog.findUnique({
    where: { id },
    select: { id: true, resolvedAt: true },
  })
  if (!existing) return { ok: false, error: 'Ошибка не найдена' }
  if (existing.resolvedAt) return { ok: false, error: 'Уже закрыта' }

  await prisma.$transaction([
    prisma.errorLog.update({
      where: { id },
      data: { resolvedAt: new Date(), resolvedBy: me.id },
    }),
    prisma.activityLog.create({
      data: {
        userId: me.id,
        userRole: me.role,
        action: 'ADMIN_RESOLVE_ERROR',
        entityType: 'ErrorLog',
        entityId: id,
        payload: { errorId: id },
      },
    }),
  ])

  revalidatePath('/settings/errors')
  revalidatePath(`/settings/errors/${id}`)
  return { ok: true }
}

export async function reopenError(id: string): Promise<ActionResult> {
  const me = await requireRole(['ADMIN'])

  const existing = await prisma.errorLog.findUnique({
    where: { id },
    select: { id: true, resolvedAt: true },
  })
  if (!existing) return { ok: false, error: 'Ошибка не найдена' }
  if (!existing.resolvedAt) return { ok: false, error: 'Уже открыта' }

  await prisma.$transaction([
    prisma.errorLog.update({
      where: { id },
      data: { resolvedAt: null, resolvedBy: null },
    }),
    prisma.activityLog.create({
      data: {
        userId: me.id,
        userRole: me.role,
        action: 'ADMIN_REOPEN_ERROR',
        entityType: 'ErrorLog',
        entityId: id,
        payload: { errorId: id },
      },
    }),
  ])

  revalidatePath('/settings/errors')
  revalidatePath(`/settings/errors/${id}`)
  return { ok: true }
}
