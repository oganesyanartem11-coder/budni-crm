'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import {
  legalEntitySchema,
  type LegalEntityFormData,
} from '@/lib/validation/legal-entity'
import type { OurLegalEntity, Prisma } from '@prisma/client'

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

function flattenZodIssues(
  issues: Array<{ path: PropertyKey[]; message: string }>
): { error: string; fieldErrors: Record<string, string> } {
  const fieldErrors: Record<string, string> = {}
  for (const issue of issues) {
    const key = issue.path.join('.')
    if (!fieldErrors[key]) fieldErrors[key] = issue.message
  }
  const first = issues[0]?.message ?? 'Ошибка валидации'
  return { error: first, fieldErrors }
}

/**
 * Превращает форменные данные в payload для Prisma create/update.
 * Пустые строки опциональных полей пишем как null, vatRate под NONE → null.
 */
function toPrismaPayload(data: LegalEntityFormData) {
  const kpp = data.kpp && data.kpp.length > 0 ? data.kpp : null
  const phone = data.phone && data.phone.length > 0 ? data.phone : null
  const email = data.email && data.email.length > 0 ? data.email : null

  let vatRate: Prisma.Decimal | number | null = null
  if (data.vatMode === 'VAT_10_INCLUSIVE' && typeof data.vatRate === 'number') {
    vatRate = data.vatRate
  }

  return {
    shortName: data.shortName,
    fullName: data.fullName,
    entityType: data.entityType,
    inn: data.inn,
    kpp,
    ogrn: data.ogrn,
    legalAddress: data.legalAddress,
    phone,
    email,
    bankName: data.bankName,
    bankBic: data.bankBic,
    bankAccount: data.bankAccount,
    bankCorrAccount: data.bankCorrAccount,
    directorName: data.directorName,
    directorPosition: data.directorPosition,
    vatMode: data.vatMode,
    vatRate,
  }
}

export async function listLegalEntities(): Promise<OurLegalEntity[]> {
  await requireRole(['ADMIN'])
  return prisma.ourLegalEntity.findMany({
    orderBy: { shortName: 'asc' },
  })
}

export async function getLegalEntity(
  id: string
): Promise<OurLegalEntity | null> {
  await requireRole(['ADMIN'])
  return prisma.ourLegalEntity.findUnique({ where: { id } })
}

export async function createLegalEntity(
  input: LegalEntityFormData
): Promise<ActionResult<{ id: string }>> {
  const user = await requireRole(['ADMIN'])

  const parsed = legalEntitySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, ...flattenZodIssues(parsed.error.issues) }
  }

  // Дублирование INN/OGRN — даём читаемую ошибку до уплотнения unique-constraint
  const dup = await prisma.ourLegalEntity.findFirst({
    where: { OR: [{ inn: parsed.data.inn }, { ogrn: parsed.data.ogrn }] },
    select: { inn: true, ogrn: true },
  })
  if (dup) {
    const fieldErrors: Record<string, string> = {}
    if (dup.inn === parsed.data.inn) fieldErrors.inn = 'Юрлицо с таким ИНН уже существует'
    if (dup.ogrn === parsed.data.ogrn) fieldErrors.ogrn = 'Юрлицо с таким ОГРН/ОГРНИП уже существует'
    return {
      ok: false,
      error: fieldErrors.inn ?? fieldErrors.ogrn ?? 'Юрлицо уже существует',
      fieldErrors,
    }
  }

  const created = await prisma.ourLegalEntity.create({
    data: toPrismaPayload(parsed.data),
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'LEGAL_ENTITY_CREATED',
      entityType: 'OurLegalEntity',
      entityId: created.id,
      payload: { id: created.id, shortName: created.shortName, inn: created.inn },
    },
  })

  revalidatePath('/settings/legal-entities')
  return { ok: true, data: { id: created.id } }
}

export async function updateLegalEntity(
  id: string,
  input: LegalEntityFormData
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN'])

  const parsed = legalEntitySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, ...flattenZodIssues(parsed.error.issues) }
  }

  const existing = await prisma.ourLegalEntity.findUnique({ where: { id } })
  if (!existing) return { ok: false, error: 'Юрлицо не найдено' }

  // Дубли inn/ogrn по другим записям
  const dup = await prisma.ourLegalEntity.findFirst({
    where: {
      AND: [
        { id: { not: id } },
        { OR: [{ inn: parsed.data.inn }, { ogrn: parsed.data.ogrn }] },
      ],
    },
    select: { inn: true, ogrn: true },
  })
  if (dup) {
    const fieldErrors: Record<string, string> = {}
    if (dup.inn === parsed.data.inn) fieldErrors.inn = 'Другое юрлицо с таким ИНН уже существует'
    if (dup.ogrn === parsed.data.ogrn) fieldErrors.ogrn = 'Другое юрлицо с таким ОГРН/ОГРНИП уже существует'
    return {
      ok: false,
      error: fieldErrors.inn ?? fieldErrors.ogrn ?? 'Юрлицо уже существует',
      fieldErrors,
    }
  }

  // Diff для лога — только реально изменившиеся поля. lastDocumentNumber и
  // lastDocumentYear через update НЕ редактируются (управляются генератором УПД).
  const payload = toPrismaPayload(parsed.data)
  const changed: string[] = []
  for (const key of Object.keys(payload) as Array<keyof typeof payload>) {
    const before = (existing as unknown as Record<string, unknown>)[key]
    const after = (payload as unknown as Record<string, unknown>)[key]
    // Decimal сравниваем через String — Prisma.Decimal не сравнивается через ===
    if (String(before ?? '') !== String(after ?? '')) {
      changed.push(key as string)
    }
  }

  await prisma.ourLegalEntity.update({
    where: { id },
    data: payload,
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'LEGAL_ENTITY_UPDATED',
      entityType: 'OurLegalEntity',
      entityId: id,
      payload: { id, changed },
    },
  })

  revalidatePath('/settings/legal-entities')
  revalidatePath(`/settings/legal-entities/${id}/edit`)
  return { ok: true, data: undefined }
}

export async function setLegalEntityActive(
  id: string,
  isActive: boolean
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN'])

  const existing = await prisma.ourLegalEntity.findUnique({
    where: { id },
    select: { id: true, shortName: true, isActive: true },
  })
  if (!existing) return { ok: false, error: 'Юрлицо не найдено' }

  if (existing.isActive === isActive) {
    return { ok: true, data: undefined }
  }

  await prisma.ourLegalEntity.update({
    where: { id },
    data: { isActive },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: isActive ? 'LEGAL_ENTITY_REACTIVATED' : 'LEGAL_ENTITY_DEACTIVATED',
      entityType: 'OurLegalEntity',
      entityId: id,
      payload: { id, shortName: existing.shortName },
    },
  })

  revalidatePath('/settings/legal-entities')
  return { ok: true, data: undefined }
}
