'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { generateInviteToken, buildOnboardingDeeplink } from '@/lib/bot/onboarding'
import { promoteToActiveByChatId } from '@/lib/bot/max-users'

/**
 * 7.56: server actions для multi-user MAX в карточке клиента.
 * Привязки (ClientMaxUser) создаются ТОЛЬКО через инвайт-флоу (deep-link →
 * bot_started). Здесь — генерация/отзыв инвайтов и управление активным
 * пользователем. Auth: ADMIN/MANAGER (requireRole добавляет ADMIN_PRO).
 */

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface MaxInviteDTO {
  id: string
  token: string
  phone: string
  label: string | null
  expiresAt: Date
  url: string
}

/** Нормализует телефон до цифр. Возвращает null если цифр нет. */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  return digits.length > 0 ? digits : null
}

/**
 * Генерирует одноразовую ссылку-приглашение для привязки MAX-пользователя.
 * Дедуп: если на этот телефон уже есть живой (не использованный, не истёкший)
 * инвайт — возвращает его же, не плодит дубль.
 */
export async function createMaxInvite(
  clientId: string,
  phone: string,
  label?: string | null
): Promise<ActionResult<MaxInviteDTO>> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const normalizedPhone = normalizePhone(phone)
  if (!normalizedPhone) {
    return { ok: false, error: 'Укажите номер телефона' }
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true },
  })
  if (!client) return { ok: false, error: 'Клиент не найден' }

  const now = new Date()

  // Дедуп: живой инвайт на тот же телефон → возвращаем существующий.
  const existing = await prisma.clientMaxInvite.findFirst({
    where: {
      clientId,
      phone: normalizedPhone,
      usedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (existing) {
    return {
      ok: true,
      data: {
        id: existing.id,
        token: existing.token,
        phone: existing.phone,
        label: existing.label,
        expiresAt: existing.expiresAt,
        url: buildOnboardingDeeplink(existing.token),
      },
    }
  }

  const token = generateInviteToken()
  const invite = await prisma.clientMaxInvite.create({
    data: {
      token,
      clientId,
      phone: normalizedPhone,
      label: label?.trim() || null,
      createdById: user.id,
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    },
  })

  revalidatePath(`/clients/${clientId}`)
  return {
    ok: true,
    data: {
      id: invite.id,
      token: invite.token,
      phone: invite.phone,
      label: invite.label,
      expiresAt: invite.expiresAt,
      url: buildOnboardingDeeplink(invite.token),
    },
  }
}

/** Отзывает (инвалидирует) ещё не использованный инвайт — ставит expiresAt=now. */
export async function revokeMaxInvite(inviteId: string): Promise<ActionResult> {
  await requireRole(['ADMIN', 'MANAGER'])

  const invite = await prisma.clientMaxInvite.findUnique({
    where: { id: inviteId },
    select: { id: true, clientId: true },
  })
  if (!invite) return { ok: false, error: 'Приглашение не найдено' }

  await prisma.clientMaxInvite.update({
    where: { id: inviteId },
    data: { expiresAt: new Date() },
  })

  revalidatePath(`/clients/${invite.clientId}`)
  return { ok: true, data: undefined }
}

/**
 * Делает указанного пользователя активным для клиента. Валидирует, что chatId
 * принадлежит ИМЕННО этому клиенту (защита от межклиентского переключения).
 */
export async function promoteMaxUserManually(
  clientId: string,
  chatId: string
): Promise<ActionResult> {
  await requireRole(['ADMIN', 'MANAGER'])

  const link = await prisma.clientMaxUser.findUnique({
    where: { chatId },
    select: { clientId: true },
  })
  if (!link || link.clientId !== clientId) {
    return { ok: false, error: 'Пользователь не принадлежит этому клиенту' }
  }

  await promoteToActiveByChatId(chatId)

  revalidatePath(`/clients/${clientId}`)
  return { ok: true, data: undefined }
}

/**
 * Удаляет привязку (ClientMaxUser). Если удаляемый был активным — назначает
 * новым активным оставшегося с самым свежим lastSeenAt. Если оставшихся нет —
 * клиент остаётся без активного (бот перестаёт ему писать, это нормально).
 */
export async function deleteMaxUser(
  clientId: string,
  chatId: string
): Promise<ActionResult> {
  await requireRole(['ADMIN', 'MANAGER'])

  const link = await prisma.clientMaxUser.findUnique({
    where: { chatId },
    select: { id: true, clientId: true, isActive: true },
  })
  if (!link || link.clientId !== clientId) {
    return { ok: false, error: 'Пользователь не принадлежит этому клиенту' }
  }

  await prisma.clientMaxUser.delete({ where: { id: link.id } })

  // Если удалили активного — выбираем нового по самому свежему lastSeenAt.
  if (link.isActive) {
    const next = await prisma.clientMaxUser.findFirst({
      where: { clientId },
      orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { linkedAt: 'desc' }],
      select: { id: true },
    })
    if (next) {
      await prisma.clientMaxUser.update({
        where: { id: next.id },
        data: { isActive: true },
      })
    }
  }

  revalidatePath(`/clients/${clientId}`)
  return { ok: true, data: undefined }
}
