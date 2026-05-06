'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'

const clientSchema = z.object({
  name: z.string().trim().min(1, 'Название обязательно').max(150),
  contactName: z.string().max(100).nullable().optional(),
  contactPhone: z.string().max(50).nullable().optional().refine(
    (v) => {
      if (!v) return true
      const digits = v.replace(/\D/g, '')
      return digits.length === 11 && digits.startsWith('7')
    },
    { message: 'Телефон должен быть в формате +7 (999) 999-99-99' }
  ),
  contactMessenger: z.string().max(100).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
})

const locationSchema = z.object({
  name: z.string().trim().min(1, 'Название точки обязательно').max(150),
  address: z.string().trim().min(1, 'Адрес обязателен').max(300),
  deliveryWindowFrom: z.string().regex(/^\d{2}:\d{2}$/, 'Формат HH:MM').nullable().optional(),
  deliveryWindowTo: z.string().regex(/^\d{2}:\d{2}$/, 'Формат HH:MM').nullable().optional(),
  packaging: z.enum(['INDIVIDUAL', 'BULK']),
  tags: z.array(z.string().max(100)).max(20).default([]),
})

const mealConfigSchema = z.object({
  locationId: z.string().nullable().optional(),
  mealType: z.enum(['BREAKFAST', 'LUNCH', 'DINNER']),
  orderType: z.enum(['DYNAMIC', 'FIXED']),
  deliveryHorizon: z.enum(['NEXT_DAY', 'SAME_DAY']).default('NEXT_DAY'),
  scheduleType: z.enum(['DAILY', 'WEEKDAYS', 'WEEKENDS', 'CUSTOM_DAYS', 'ONE_TIME', 'INTERVAL']),
  scheduleData: z.record(z.string(), z.any()).nullable().optional(),
  fixedPortions: z.number().int().positive().nullable().optional(),
  pricePerPortion: z.number().nonnegative('Цена не может быть отрицательной'),
  validFrom: z.string().nullable().optional(), // ISO
  validTo: z.string().nullable().optional(),
})

export type ClientFormData = z.infer<typeof clientSchema>
export type LocationFormData = z.infer<typeof locationSchema>
export type MealConfigFormData = z.infer<typeof mealConfigSchema>

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

// CLIENT ============================================================

export async function createClient(
  formData: ClientFormData & { firstLocation?: LocationFormData }
): Promise<ActionResult<{ id: string }>> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = clientSchema.safeParse(formData)
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return { ok: false, error: firstError?.message ?? 'Неверные данные клиента' }
  }

  let locationData: LocationFormData | null = null
  if (formData.firstLocation) {
    const locParsed = locationSchema.safeParse(formData.firstLocation)
    if (!locParsed.success) {
      const firstError = locParsed.error.issues[0]
      return { ok: false, error: firstError?.message ?? 'Неверные данные точки' }
    }
    locationData = locParsed.data
  }

  const client = await prisma.client.create({
    data: {
      name: parsed.data.name,
      contactName: parsed.data.contactName ?? null,
      contactPhone: parsed.data.contactPhone ?? null,
      contactMessenger: parsed.data.contactMessenger ?? null,
      notes: parsed.data.notes ?? null,
      ...(locationData && {
        locations: {
          create: {
            name: locationData.name,
            address: locationData.address,
            deliveryWindowFrom: locationData.deliveryWindowFrom ?? null,
            deliveryWindowTo: locationData.deliveryWindowTo ?? null,
            packaging: locationData.packaging,
            tags: locationData.tags,
          },
        },
      }),
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'CLIENT_CREATED',
      entityType: 'Client',
      entityId: client.id,
      payload: { name: client.name },
    },
  })

  revalidatePath('/clients')
  return { ok: true, data: { id: client.id } }
}

export async function updateClient(
  id: string,
  formData: ClientFormData
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = clientSchema.safeParse(formData)
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return { ok: false, error: firstError?.message ?? 'Неверные данные клиента' }
  }

  await prisma.client.update({
    where: { id },
    data: {
      name: parsed.data.name,
      contactName: parsed.data.contactName ?? null,
      contactPhone: parsed.data.contactPhone ?? null,
      contactMessenger: parsed.data.contactMessenger ?? null,
      notes: parsed.data.notes ?? null,
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'CLIENT_UPDATED',
      entityType: 'Client',
      entityId: id,
      payload: { name: parsed.data.name },
    },
  })

  revalidatePath('/clients')
  revalidatePath(`/clients/${id}`)
  return { ok: true, data: undefined }
}

export async function archiveClient(id: string): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER'])
  const current = await prisma.client.findUnique({ where: { id } })
  if (!current) return { ok: false, error: 'Клиент не найден' }

  await prisma.client.update({
    where: { id },
    data: { isActive: !current.isActive },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: current.isActive ? 'CLIENT_ARCHIVED' : 'CLIENT_RESTORED',
      entityType: 'Client',
      entityId: id,
      payload: { name: current.name },
    },
  })

  revalidatePath('/clients')
  revalidatePath(`/clients/${id}`)
  return { ok: true, data: undefined }
}

// LOCATION ==========================================================

export async function createLocation(
  clientId: string,
  formData: LocationFormData
): Promise<ActionResult<{ id: string }>> {
  await requireRole(['ADMIN', 'MANAGER'])

  const parsed = locationSchema.safeParse(formData)
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return { ok: false, error: firstError?.message ?? 'Неверные данные точки' }
  }

  const location = await prisma.clientLocation.create({
    data: {
      clientId,
      name: parsed.data.name,
      address: parsed.data.address,
      deliveryWindowFrom: parsed.data.deliveryWindowFrom ?? null,
      deliveryWindowTo: parsed.data.deliveryWindowTo ?? null,
      packaging: parsed.data.packaging,
      tags: parsed.data.tags,
    },
  })

  revalidatePath(`/clients/${clientId}`)
  return { ok: true, data: { id: location.id } }
}

export async function updateLocation(
  id: string,
  formData: LocationFormData
): Promise<ActionResult> {
  await requireRole(['ADMIN', 'MANAGER'])

  const parsed = locationSchema.safeParse(formData)
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return { ok: false, error: firstError?.message ?? 'Неверные данные точки' }
  }

  const location = await prisma.clientLocation.update({
    where: { id },
    data: {
      name: parsed.data.name,
      address: parsed.data.address,
      deliveryWindowFrom: parsed.data.deliveryWindowFrom ?? null,
      deliveryWindowTo: parsed.data.deliveryWindowTo ?? null,
      packaging: parsed.data.packaging,
      tags: parsed.data.tags,
    },
  })

  revalidatePath(`/clients/${location.clientId}`)
  return { ok: true, data: undefined }
}

export async function archiveLocation(id: string): Promise<ActionResult> {
  await requireRole(['ADMIN', 'MANAGER'])
  const current = await prisma.clientLocation.findUnique({ where: { id } })
  if (!current) return { ok: false, error: 'Точка не найдена' }

  await prisma.clientLocation.update({
    where: { id },
    data: { isActive: !current.isActive },
  })

  revalidatePath(`/clients/${current.clientId}`)
  return { ok: true, data: undefined }
}

// MEAL CONFIG =======================================================

/** @deprecated Use createMealConfigBulk for new code */
export async function createMealConfig(
  clientId: string,
  formData: MealConfigFormData
): Promise<ActionResult<{ id: string }>> {
  await requireRole(['ADMIN', 'MANAGER'])

  const parsed = mealConfigSchema.safeParse(formData)
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return { ok: false, error: firstError?.message ?? 'Неверные данные конфига' }
  }

  if (parsed.data.orderType === 'FIXED' && !parsed.data.fixedPortions) {
    return { ok: false, error: 'Для FIXED укажите количество порций' }
  }

  const config = await prisma.clientMealConfig.create({
    data: {
      clientId,
      locationId: parsed.data.locationId ?? null,
      mealType: parsed.data.mealType,
      orderType: parsed.data.orderType,
      deliveryHorizon: parsed.data.deliveryHorizon,
      scheduleType: parsed.data.scheduleType,
      scheduleData: parsed.data.scheduleData ?? undefined,
      fixedPortions: parsed.data.fixedPortions ?? null,
      pricePerPortion: parsed.data.pricePerPortion,
      validFrom: parsed.data.validFrom ? new Date(parsed.data.validFrom) : new Date(),
      validTo: parsed.data.validTo ? new Date(parsed.data.validTo) : null,
    },
  })

  revalidatePath(`/clients/${clientId}`)
  return { ok: true, data: { id: config.id } }
}

export async function updateMealConfig(
  id: string,
  formData: MealConfigFormData
): Promise<ActionResult> {
  await requireRole(['ADMIN', 'MANAGER'])

  const parsed = mealConfigSchema.safeParse(formData)
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return { ok: false, error: firstError?.message ?? 'Неверные данные конфига' }
  }

  const config = await prisma.clientMealConfig.update({
    where: { id },
    data: {
      locationId: parsed.data.locationId ?? null,
      mealType: parsed.data.mealType,
      orderType: parsed.data.orderType,
      deliveryHorizon: parsed.data.deliveryHorizon,
      scheduleType: parsed.data.scheduleType,
      scheduleData: parsed.data.scheduleData ?? undefined,
      fixedPortions: parsed.data.fixedPortions ?? null,
      pricePerPortion: parsed.data.pricePerPortion,
      validFrom: parsed.data.validFrom ? new Date(parsed.data.validFrom) : undefined,
      validTo: parsed.data.validTo ? new Date(parsed.data.validTo) : null,
    },
  })

  revalidatePath(`/clients/${config.clientId}`)
  return { ok: true, data: undefined }
}

export async function deleteMealConfig(id: string): Promise<ActionResult> {
  await requireRole(['ADMIN', 'MANAGER'])
  const config = await prisma.clientMealConfig.findUnique({ where: { id } })
  if (!config) return { ok: false, error: 'Конфиг не найден' }

  await prisma.clientMealConfig.update({
    where: { id },
    data: { isActive: !config.isActive },
  })

  revalidatePath(`/clients/${config.clientId}`)
  return { ok: true, data: undefined }
}

const mealConfigBulkSchema = z.object({
  locationId: z.string().nullable().optional(),
  mealTypes: z.array(z.enum(['BREAKFAST', 'LUNCH', 'DINNER'])).min(1, 'Выберите хотя бы один тип питания'),
  // Цены отдельно по каждому типу: { BREAKFAST: 200, LUNCH: 380, DINNER: 320 }
  pricesByType: z.record(z.string(), z.number().nonnegative()),
  orderType: z.enum(['DYNAMIC', 'FIXED']),
  deliveryHorizon: z.enum(['NEXT_DAY', 'SAME_DAY']).default('NEXT_DAY'),
  scheduleType: z.enum(['DAILY', 'WEEKDAYS', 'WEEKENDS', 'CUSTOM_DAYS', 'ONE_TIME', 'INTERVAL']),
  scheduleData: z.record(z.string(), z.any()).nullable().optional(),
  fixedPortionsByType: z.record(z.string(), z.number().int().positive()).nullable().optional(),
  validFrom: z.string().nullable().optional(),
  validTo: z.string().nullable().optional(),
})

export type MealConfigBulkFormData = z.infer<typeof mealConfigBulkSchema>

export async function createMealConfigBulk(
  clientId: string,
  formData: MealConfigBulkFormData
): Promise<ActionResult<{ ids: string[] }>> {
  await requireRole(['ADMIN', 'MANAGER'])

  const parsed = mealConfigBulkSchema.safeParse(formData)
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return { ok: false, error: firstError?.message ?? 'Неверные данные' }
  }

  const { mealTypes, pricesByType, fixedPortionsByType } = parsed.data

  // Проверка: для FIXED у каждого типа должны быть порции
  if (parsed.data.orderType === 'FIXED') {
    for (const mt of mealTypes) {
      if (!fixedPortionsByType?.[mt] || fixedPortionsByType[mt] <= 0) {
        return { ok: false, error: `Для FIXED укажите количество порций (${mt})` }
      }
    }
  }

  // Проверка: цена есть для каждого выбранного типа
  for (const mt of mealTypes) {
    if (typeof pricesByType[mt] !== 'number') {
      return { ok: false, error: `Укажите цену для всех выбранных типов питания` }
    }
  }

  // Создаём конфиги атомарно
  const created = await prisma.$transaction(
    mealTypes.map((mt) =>
      prisma.clientMealConfig.create({
        data: {
          clientId,
          locationId: parsed.data.locationId ?? null,
          mealType: mt,
          orderType: parsed.data.orderType,
          deliveryHorizon: parsed.data.deliveryHorizon,
          scheduleType: parsed.data.scheduleType,
          scheduleData: parsed.data.scheduleData ?? undefined,
          fixedPortions: parsed.data.orderType === 'FIXED' ? (fixedPortionsByType?.[mt] ?? null) : null,
          pricePerPortion: pricesByType[mt],
          validFrom: parsed.data.validFrom ? new Date(parsed.data.validFrom) : new Date(),
          validTo: parsed.data.validTo ? new Date(parsed.data.validTo) : null,
        },
      })
    )
  )

  revalidatePath(`/clients/${clientId}`)
  return { ok: true, data: { ids: created.map((c) => c.id) } }
}
