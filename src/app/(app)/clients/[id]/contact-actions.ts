'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import type { ActionResult } from '../actions'

// Контактные лица клиента (П1). Один обязательный реквизит — телефон;
// остальное опционально. Нормализуем пустые строки в null тем же приёмом,
// что и в clients/actions.ts (хелпер `s` ниже — локальная копия, чтобы не
// тащить приватный хелпер из соседнего файла).

const contactSchema = z.object({
  name: z.string().trim().max(150).nullable().optional(),
  role: z.string().trim().max(100).nullable().optional(),
  phone: z.string().trim().min(5, 'Телефон обязателен').max(50),
  email: z
    .string()
    .trim()
    .max(150)
    .email('Некорректный email')
    .nullable()
    .optional()
    .or(z.literal('')),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export type ClientContactFormData = z.infer<typeof contactSchema>

export type ClientContactDTO = {
  id: string
  clientId: string
  name: string | null
  role: string | null
  phone: string
  email: string | null
  notes: string | null
  sortOrder: number
}

// '' / undefined / null → null; непустая строка остаётся как есть.
function s(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null
  const trimmed = v.trim()
  return trimmed === '' ? null : trimmed
}

function toContactPayload(data: ClientContactFormData) {
  return {
    name: s(data.name),
    role: s(data.role),
    phone: data.phone.trim(),
    email: s(data.email),
    notes: s(data.notes),
  }
}

export async function createClientContact(
  clientId: string,
  formData: ClientContactFormData
): Promise<ActionResult<ClientContactDTO>> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = contactSchema.safeParse(formData)
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return { ok: false, error: firstError?.message ?? 'Неверные данные контакта' }
  }

  // sortOrder = (макс. существующий для клиента ?? 0) + 10.
  const last = await prisma.clientContact.findFirst({
    where: { clientId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  })
  const sortOrder = (last?.sortOrder ?? 0) + 10

  const payload = toContactPayload(parsed.data)

  const contact = await prisma.clientContact.create({
    data: {
      clientId,
      ...payload,
      sortOrder,
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'CLIENT_CONTACT_CREATED',
      entityType: 'Client',
      entityId: clientId,
      payload: { contactId: contact.id, name: payload.name, phone: payload.phone },
    },
  })

  revalidatePath(`/clients/${clientId}`)
  return {
    ok: true,
    data: {
      id: contact.id,
      clientId: contact.clientId,
      name: contact.name,
      role: contact.role,
      phone: contact.phone,
      email: contact.email,
      notes: contact.notes,
      sortOrder: contact.sortOrder,
    },
  }
}

export async function updateClientContact(
  contactId: string,
  formData: ClientContactFormData
): Promise<ActionResult<ClientContactDTO>> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = contactSchema.safeParse(formData)
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return { ok: false, error: firstError?.message ?? 'Неверные данные контакта' }
  }

  const existing = await prisma.clientContact.findUnique({
    where: { id: contactId },
    select: { clientId: true },
  })
  if (!existing) return { ok: false, error: 'Контакт не найден' }

  const payload = toContactPayload(parsed.data)

  const contact = await prisma.clientContact.update({
    where: { id: contactId },
    data: payload,
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'CLIENT_CONTACT_UPDATED',
      entityType: 'Client',
      entityId: existing.clientId,
      payload: { contactId, name: payload.name, phone: payload.phone },
    },
  })

  revalidatePath(`/clients/${existing.clientId}`)
  return {
    ok: true,
    data: {
      id: contact.id,
      clientId: contact.clientId,
      name: contact.name,
      role: contact.role,
      phone: contact.phone,
      email: contact.email,
      notes: contact.notes,
      sortOrder: contact.sortOrder,
    },
  }
}

export async function deleteClientContact(contactId: string): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const existing = await prisma.clientContact.findUnique({
    where: { id: contactId },
    select: { clientId: true, name: true, phone: true },
  })
  if (!existing) return { ok: false, error: 'Контакт не найден' }

  await prisma.clientContact.delete({ where: { id: contactId } })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'CLIENT_CONTACT_DELETED',
      entityType: 'Client',
      entityId: existing.clientId,
      payload: { contactId, name: existing.name, phone: existing.phone },
    },
  })

  revalidatePath(`/clients/${existing.clientId}`)
  return { ok: true, data: undefined }
}
