'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { generateOnboardingToken, buildOnboardingDeeplink } from '@/lib/bot/onboarding'
import { startOfTodayMsk } from '@/lib/utils/msk-window'
import {
  validateInn,
  validateOgrn,
  validateBic,
  validateAccount,
  validateCorrAccount,
} from '@/lib/validation/russian-requisites'

const clientSchema = z
  .object({
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

    // === Юр.реквизиты (7b) — все опционально на уровне типа,
    // обязательность связана с inn через superRefine ниже.
    legalName: z.string().max(500).optional().or(z.literal('')),
    inn: z.string().optional().or(z.literal('')),
    kpp: z.string().regex(/^\d{9}$/, 'КПП — 9 цифр').optional().or(z.literal('')),
    ogrn: z.string().optional().or(z.literal('')),
    legalAddress: z.string().max(500).optional().or(z.literal('')),

    bankName: z.string().max(200).optional().or(z.literal('')),
    bankBic: z.string().optional().or(z.literal('')),
    bankAccount: z.string().optional().or(z.literal('')),
    bankCorrAccount: z.string().optional().or(z.literal('')),

    contractNumber: z.string().max(50).optional().or(z.literal('')),
    contractDate: z.string().optional().or(z.literal('')), // ISO date string YYYY-MM-DD

    defaultOurLegalEntityId: z.string().optional().or(z.literal('')),
  })
  .superRefine((data, ctx) => {
    const innFilled = !!data.inn && data.inn !== ''

    // Юрлицо: если inn заполнен — требуем полный набор + ИНН валиден
    if (innFilled) {
      if (!validateInn(data.inn!)) {
        ctx.addIssue({ code: 'custom', path: ['inn'], message: 'Некорректный ИНН (контрольная сумма не сошлась)' })
      }
      if (!data.legalName || data.legalName === '') {
        ctx.addIssue({ code: 'custom', path: ['legalName'], message: 'Укажите полное юридическое название' })
      }
      if (!data.ogrn || data.ogrn === '') {
        ctx.addIssue({ code: 'custom', path: ['ogrn'], message: 'Укажите ОГРН/ОГРНИП' })
      }
      if (!data.legalAddress || data.legalAddress === '') {
        ctx.addIssue({ code: 'custom', path: ['legalAddress'], message: 'Укажите юридический адрес' })
      }
      if (!data.defaultOurLegalEntityId || data.defaultOurLegalEntityId === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['defaultOurLegalEntityId'],
          message: 'Выберите наше юрлицо для отгрузки',
        })
      }

      // КПП: для 10-значного ИНН обязателен, для 12-значного — запрещён
      if (data.inn!.length === 10) {
        if (!data.kpp || data.kpp === '') {
          ctx.addIssue({ code: 'custom', path: ['kpp'], message: 'КПП обязателен для организации' })
        }
      } else if (data.inn!.length === 12) {
        if (data.kpp && data.kpp !== '') {
          ctx.addIssue({ code: 'custom', path: ['kpp'], message: 'КПП не используется для ИП — оставьте пустым' })
        }
      }

      // ОГРН: контрольная сумма + длина под тип ИНН
      if (data.ogrn && data.ogrn !== '') {
        if (!validateOgrn(data.ogrn)) {
          ctx.addIssue({ code: 'custom', path: ['ogrn'], message: 'Некорректный ОГРН/ОГРНИП (контрольная сумма)' })
        } else {
          if (data.inn!.length === 10 && data.ogrn.length !== 13) {
            ctx.addIssue({ code: 'custom', path: ['ogrn'], message: 'Для организации — ОГРН должен быть 13 цифр' })
          }
          if (data.inn!.length === 12 && data.ogrn.length !== 15) {
            ctx.addIssue({ code: 'custom', path: ['ogrn'], message: 'Для ИП — ОГРНИП должен быть 15 цифр' })
          }
        }
      }
    } else {
      // Если inn пустой — все юр.поля должны быть пустыми (нельзя «частично юрлицо»)
      const juridicalFields: Array<keyof typeof data> = [
        'legalName',
        'kpp',
        'ogrn',
        'legalAddress',
        'defaultOurLegalEntityId',
      ]
      for (const field of juridicalFields) {
        const v = data[field] as string | undefined
        if (v && v !== '') {
          ctx.addIssue({
            code: 'custom',
            path: ['inn'],
            message: 'Если заполнены юр.поля — обязательно укажите ИНН (или очистите остальные поля)',
          })
          break
        }
      }
    }

    // Банк.реквизиты — всё или ничего
    const bankValues = [data.bankName, data.bankBic, data.bankAccount, data.bankCorrAccount]
    const filledBank = bankValues.filter((f) => f && f !== '').length
    if (filledBank > 0 && filledBank < 4) {
      if (!data.bankName) ctx.addIssue({ code: 'custom', path: ['bankName'], message: 'Заполните все банковские реквизиты или оставьте все пустыми' })
      if (!data.bankBic) ctx.addIssue({ code: 'custom', path: ['bankBic'], message: 'Заполните все банковские реквизиты или оставьте все пустыми' })
      if (!data.bankAccount) ctx.addIssue({ code: 'custom', path: ['bankAccount'], message: 'Заполните все банковские реквизиты или оставьте все пустыми' })
      if (!data.bankCorrAccount) ctx.addIssue({ code: 'custom', path: ['bankCorrAccount'], message: 'Заполните все банковские реквизиты или оставьте все пустыми' })
    }
    if (filledBank === 4) {
      if (!validateBic(data.bankBic!)) {
        ctx.addIssue({ code: 'custom', path: ['bankBic'], message: 'Некорректный БИК' })
      } else {
        if (!validateAccount(data.bankAccount!, data.bankBic!)) {
          ctx.addIssue({ code: 'custom', path: ['bankAccount'], message: 'Расчётный счёт: контрольная сумма не сходится с БИК' })
        }
        if (!validateCorrAccount(data.bankCorrAccount!, data.bankBic!)) {
          ctx.addIssue({ code: 'custom', path: ['bankCorrAccount'], message: 'Корр. счёт: контрольная сумма не сходится с БИК' })
        }
      }
    }

    // Договор: оба поля или ни одного
    const hasContractNumber = !!data.contractNumber && data.contractNumber !== ''
    const hasContractDate = !!data.contractDate && data.contractDate !== ''
    if (hasContractNumber !== hasContractDate) {
      if (!hasContractNumber) {
        ctx.addIssue({ code: 'custom', path: ['contractNumber'], message: 'Укажите номер договора или очистите дату' })
      }
      if (!hasContractDate) {
        ctx.addIssue({ code: 'custom', path: ['contractDate'], message: 'Укажите дату договора или очистите номер' })
      }
    }
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
  // 5.9b: locationId обязателен. Старые null-конфиги в БД остаются (миграция позже).
  locationId: z.string().min(1, 'Выберите локацию'),
  mealType: z.enum(['BREAKFAST', 'LUNCH', 'DINNER']),
  orderType: z.enum(['DYNAMIC', 'FIXED']),
  deliveryHorizon: z.enum(['NEXT_DAY', 'SAME_DAY']).default('NEXT_DAY'),
  scheduleType: z.enum(['DAILY', 'WEEKDAYS', 'WEEKENDS', 'CUSTOM_DAYS', 'ONE_TIME', 'INTERVAL']),
  scheduleData: z.record(z.string(), z.any()).nullable().optional(),
  fixedPortions: z.number().int().positive().nullable().optional(),
  pricePerPortion: z.number().nonnegative('Цена не может быть отрицательной'),
  validFrom: z.string().nullable().optional(), // ISO
  validTo: z.string().nullable().optional(),
  // E-блок MEGA-AUDIT-FIX-2: при изменении fixedPortions показываем менеджеру
  // счётчик будущих DRAFT/PENDING заказов и даём выбор — обновить или оставить.
  confirmDraftPortions: z.enum(['keep', 'update']).optional(),
})

export type ClientFormData = z.infer<typeof clientSchema>
export type LocationFormData = z.infer<typeof locationSchema>
export type MealConfigFormData = z.infer<typeof mealConfigSchema>

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

// E-блок MEGA-AUDIT-FIX-2: расширенный результат для updateMealConfig — когда
// меняется fixedPortions, action возвращает needsConfirmation с числом затронутых
// будущих DRAFT/PENDING заказов, чтобы UI спросил подтверждение у менеджера.
export type UpdateMealConfigResult =
  | { ok: true; data: undefined }
  | { ok: false; error: string }
  | {
      ok: false
      needsConfirmation: true
      affectedOrders: number
      oldPortions: number
      newPortions: number
      error: string
    }

// Нормализация: '' / undefined / null → null; не-пустая строка остаётся как есть.
function s(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null
  const trimmed = v.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Собирает payload для Prisma из ClientFormData, нормализуя пустые строки в null.
 * Включает все юр.поля Спринта 7b. Для contactPhone/Messenger/notes используется
 * тот же `s()` хелпер вместо старого `?? null` — поведение идентичное.
 */
function toClientRequisitesPayload(data: ClientFormData) {
  return {
    contactName: s(data.contactName),
    contactPhone: s(data.contactPhone),
    contactMessenger: s(data.contactMessenger),
    notes: s(data.notes),

    legalName: s(data.legalName),
    inn: s(data.inn),
    kpp: s(data.kpp),
    ogrn: s(data.ogrn),
    legalAddress: s(data.legalAddress),

    bankName: s(data.bankName),
    bankBic: s(data.bankBic),
    bankAccount: s(data.bankAccount),
    bankCorrAccount: s(data.bankCorrAccount),

    contractNumber: s(data.contractNumber),
    contractDate: data.contractDate ? new Date(data.contractDate) : null,

    defaultOurLegalEntityId: s(data.defaultOurLegalEntityId),
  }
}

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

  const requisites = toClientRequisitesPayload(parsed.data)

  const client = await prisma.client.create({
    data: {
      name: parsed.data.name,
      ...requisites,
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
      payload: {
        name: client.name,
        inn: requisites.inn,
        defaultOurLegalEntityId: requisites.defaultOurLegalEntityId,
      },
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

  // Diff: фиксируем для лога какие юр./связь-поля поменялись
  const before = await prisma.client.findUnique({
    where: { id },
    select: {
      inn: true,
      defaultOurLegalEntityId: true,
      contractNumber: true,
    },
  })

  const requisites = toClientRequisitesPayload(parsed.data)

  await prisma.client.update({
    where: { id },
    data: {
      name: parsed.data.name,
      ...requisites,
    },
  })

  const changed: Record<string, { from: string | null; to: string | null }> = {}
  if (before) {
    if ((before.inn ?? null) !== (requisites.inn ?? null)) {
      changed.inn = { from: before.inn ?? null, to: requisites.inn ?? null }
    }
    if ((before.defaultOurLegalEntityId ?? null) !== (requisites.defaultOurLegalEntityId ?? null)) {
      changed.defaultOurLegalEntityId = {
        from: before.defaultOurLegalEntityId ?? null,
        to: requisites.defaultOurLegalEntityId ?? null,
      }
    }
    if ((before.contractNumber ?? null) !== (requisites.contractNumber ?? null)) {
      changed.contractNumber = {
        from: before.contractNumber ?? null,
        to: requisites.contractNumber ?? null,
      }
    }
  }

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'CLIENT_UPDATED',
      entityType: 'Client',
      entityId: id,
      payload: {
        name: parsed.data.name,
        ...(Object.keys(changed).length > 0 ? { changed } : {}),
      },
    },
  })

  revalidatePath('/clients')
  revalidatePath(`/clients/${id}`)
  return { ok: true, data: undefined }
}

export async function archiveClient(id: string): Promise<ActionResult> {
  // MEGA-AUDIT-FIX-1 B3 (E-3): только ADMIN/ADMIN_PRO. MANAGER не может архивировать
  // клиента, у которого могут быть будущие заказы и активные конфиги.
  const user = await requireRole(['ADMIN'])
  const current = await prisma.client.findUnique({ where: { id } })
  if (!current) return { ok: false, error: 'Клиент не найден' }

  // MEGA-AUDIT-FIX-1 B2 (D-2): при архивации в одной транзакции:
  // 1) деактивируем клиента,
  // 2) отменяем будущие заказы (статусы CONFIRMED/PENDING_CONFIRMATION/DRAFT
  //    с deliveryDate >= сегодня по МСК),
  // 3) деактивируем все ClientMealConfig клиента.
  // При восстановлении (current.isActive === false) — только step 1, заказы и
  // конфиги обратно не оживляем (это явное решение менеджера).
  const willArchive = current.isActive
  const todayMsk = startOfTodayMsk()

  if (willArchive) {
    // Пред-подсчёт счётчиков, чтобы положить их в payload ActivityLog внутри
    // той же массив-транзакции (interactive-form через pgbouncer падает).
    // Гонка минимальна: окно между count и updateMany — миллисекунды; даже
    // если разойдётся на 1-2 заказа, это аудит-метка, не учёт.
    const [cancellablePreCount, configsPreCount] = await Promise.all([
      prisma.order.count({
        where: {
          clientId: id,
          status: { in: ['CONFIRMED', 'PENDING_CONFIRMATION', 'DRAFT'] },
          deliveryDate: { gte: todayMsk },
        },
      }),
      prisma.clientMealConfig.count({
        where: { clientId: id, isActive: true },
      }),
    ])

    await prisma.$transaction([
      prisma.client.update({
        where: { id },
        data: { isActive: false },
      }),
      prisma.order.updateMany({
        where: {
          clientId: id,
          status: { in: ['CONFIRMED', 'PENDING_CONFIRMATION', 'DRAFT'] },
          deliveryDate: { gte: todayMsk },
        },
        data: { status: 'CANCELLED' },
      }),
      prisma.clientMealConfig.updateMany({
        where: { clientId: id, isActive: true },
        data: { isActive: false },
      }),
      prisma.activityLog.create({
        data: {
          userId: user.id,
          userRole: user.role,
          action: 'CLIENT_ARCHIVED',
          entityType: 'Client',
          entityId: id,
          payload: {
            name: current.name,
            cancelledOrders: cancellablePreCount,
            deactivatedConfigs: configsPreCount,
          },
        },
      }),
    ])
  } else {
    await prisma.$transaction([
      prisma.client.update({
        where: { id },
        data: { isActive: true },
      }),
      prisma.activityLog.create({
        data: {
          userId: user.id,
          userRole: user.role,
          action: 'CLIENT_RESTORED',
          entityType: 'Client',
          entityId: id,
          payload: { name: current.name },
        },
      }),
    ])
  }

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

/**
 * MEGA-BACKEND блок B: назначение курьера на точку клиента.
 * courierId === null → отвязать (точка станет «непривязанной» и попадёт всем курьерам).
 * Видимость заказов курьеру в /delivery: свои точки + точки без курьера.
 */
export async function assignCourierToLocation(
  locationId: string,
  courierId: string | null
): Promise<ActionResult> {
  await requireRole(['ADMIN', 'MANAGER'])

  if (courierId !== null) {
    const courier = await prisma.user.findUnique({
      where: { id: courierId },
      select: { role: true, isActive: true },
    })
    if (!courier || courier.role !== 'COURIER' || !courier.isActive) {
      return { ok: false, error: 'Курьер не найден или неактивен' }
    }
  }

  const loc = await prisma.clientLocation.update({
    where: { id: locationId },
    data: { assignedCourierId: courierId },
    select: { clientId: true },
  })

  revalidatePath(`/clients/${loc.clientId}`)
  return { ok: true, data: undefined }
}

// MEAL CONFIG =======================================================

export async function updateMealConfig(
  id: string,
  formData: MealConfigFormData
): Promise<UpdateMealConfigResult> {
  await requireRole(['ADMIN', 'MANAGER'])

  const parsed = mealConfigSchema.safeParse(formData)
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return { ok: false, error: firstError?.message ?? 'Неверные данные питания' }
  }

  // E-блок MEGA-AUDIT-FIX-2: считаем будущие DRAFT/PENDING заказы с устаревшим
  // значением fixedPortions, чтобы дать менеджеру выбор «обновить N заказов» или
  // «оставить только конфиг». НЕ авто-обновляем.
  const existing = await prisma.clientMealConfig.findUnique({
    where: { id },
    select: { fixedPortions: true, clientId: true },
  })
  if (!existing) {
    return { ok: false, error: 'Питание не найдено' }
  }

  const oldFixedPortions = existing.fixedPortions
  const newFixedPortions = parsed.data.fixedPortions ?? null
  const portionsChanged =
    parsed.data.orderType === 'FIXED' &&
    newFixedPortions !== null &&
    oldFixedPortions !== null &&
    newFixedPortions !== oldFixedPortions

  const updateData = {
    locationId: parsed.data.locationId ?? null,
    mealType: parsed.data.mealType,
    orderType: parsed.data.orderType,
    deliveryHorizon: parsed.data.deliveryHorizon,
    scheduleType: parsed.data.scheduleType,
    scheduleData: parsed.data.scheduleData ?? undefined,
    fixedPortions: newFixedPortions,
    pricePerPortion: parsed.data.pricePerPortion,
    validFrom: parsed.data.validFrom ? new Date(parsed.data.validFrom) : undefined,
    validTo: parsed.data.validTo ? new Date(parsed.data.validTo) : null,
  }

  if (portionsChanged && !parsed.data.confirmDraftPortions) {
    const affected = await prisma.order.count({
      where: {
        sourceConfigId: id,
        status: { in: ['DRAFT', 'PENDING_CONFIRMATION'] },
        deliveryDate: { gte: startOfTodayMsk() },
      },
    })
    if (affected > 0) {
      return {
        ok: false,
        needsConfirmation: true,
        affectedOrders: affected,
        oldPortions: oldFixedPortions!,
        newPortions: newFixedPortions!,
        error: `${affected} будущих заказов с устаревшим значением. Подтвердите действие.`,
      }
    }
    // affected === 0 → молча апдейтим только конфиг
    const config = await prisma.clientMealConfig.update({
      where: { id },
      data: updateData,
    })
    revalidatePath(`/clients/${config.clientId}`)
    return { ok: true, data: undefined }
  }

  if (portionsChanged && parsed.data.confirmDraftPortions === 'update') {
    // Variant A: читаем затронутые заказы (id + pricePerPortion), затем массив-форма
    // $transaction([config.update, ...orderUpdates]). pricePerPortion индивидуален
    // per-order (snapshot), поэтому totalPrice пересчитываем отдельно на каждый.
    const orders = await prisma.order.findMany({
      where: {
        sourceConfigId: id,
        status: { in: ['DRAFT', 'PENDING_CONFIRMATION'] },
        deliveryDate: { gte: startOfTodayMsk() },
      },
      select: { id: true, pricePerPortion: true },
    })

    // Защита от слишком крупных транзакций (pgbouncer + Prisma batching).
    const LIMIT = 100
    if (orders.length > LIMIT) {
      return {
        ok: false,
        error: `Слишком много заказов для массового обновления (${orders.length} > ${LIMIT}). Отмените их вручную.`,
      }
    }

    const orderUpdates = orders.map((o) =>
      prisma.order.update({
        where: { id: o.id },
        data: {
          portions: newFixedPortions!,
          // totalPrice = portions * pricePerPortion (snapshot per-order).
          totalPrice: o.pricePerPortion.mul(newFixedPortions!),
        },
      })
    )

    const [config] = await prisma.$transaction([
      prisma.clientMealConfig.update({ where: { id }, data: updateData }),
      ...orderUpdates,
    ])

    revalidatePath(`/clients/${config.clientId}`)
    return { ok: true, data: undefined }
  }

  // Все остальные случаи (portions не менялись, либо confirmDraftPortions === 'keep'):
  // обновляем только конфиг, заказы не трогаем.
  const config = await prisma.clientMealConfig.update({
    where: { id },
    data: updateData,
  })

  revalidatePath(`/clients/${config.clientId}`)
  return { ok: true, data: undefined }
}

export async function deleteMealConfig(id: string): Promise<ActionResult> {
  await requireRole(['ADMIN', 'MANAGER'])
  const config = await prisma.clientMealConfig.findUnique({ where: { id } })
  if (!config) return { ok: false, error: 'Питание не найдено' }

  await prisma.clientMealConfig.update({
    where: { id },
    data: { isActive: !config.isActive },
  })

  revalidatePath(`/clients/${config.clientId}`)
  return { ok: true, data: undefined }
}

const mealConfigBulkSchema = z.object({
  // 5.9b: locationId обязателен (см. mealConfigSchema).
  locationId: z.string().min(1, 'Выберите локацию'),
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
): Promise<ActionResult<{ ids: string[]; autoGenerated: number }>> {
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

  // Для FIXED и DYNAMIC — сразу пытаемся сгенерировать заказ на завтра
  // (DYNAMIC получит статус PENDING_CONFIRMATION, FIXED — CONFIRMED)
  let autoGenerated = 0
  try {
    const { generateFixedOrdersForDate } = await import('@/lib/orders/generate-orders')
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(0, 0, 0, 0)
    const stats = await generateFixedOrdersForDate(tomorrow, { triggeredByUserId: null })
    autoGenerated = stats.created
  } catch (err) {
    console.error('Auto-generate after config create failed:', err)
    // 7.12: репорт в in-house tracker.
    void import('@/lib/errors/tracker').then((m) =>
      m.trackError({
        error: err,
        extra: { source: 'clients/actions:auto-generate-after-config-create' },
      })
    )
  }

  revalidatePath(`/clients/${clientId}`)
  revalidatePath('/orders')
  return {
    ok: true,
    data: {
      ids: created.map((c) => c.id),
      autoGenerated,
    },
  }
}


export async function updateClientMaxChatId(
  clientId: string,
  maxChatId: string | null
): Promise<ActionResult> {
  await requireRole(['ADMIN', 'MANAGER'])

  const value = maxChatId?.trim() ?? null
  if (value !== null) {
    if (!/^\d+$/.test(value)) {
      return { ok: false, error: 'chat_id должен состоять только из цифр' }
    }
    const existing = await prisma.client.findFirst({
      where: { maxChatId: value, NOT: { id: clientId } },
      select: { name: true },
    })
    if (existing) {
      return { ok: false, error: `Этот chat_id уже привязан к клиенту «${existing.name}»` }
    }
  }

  await prisma.client.update({
    where: { id: clientId },
    data: { maxChatId: value },
  })

  revalidatePath(`/clients/${clientId}`)
  return { ok: true, data: undefined }
}

/**
 * Список активных наших юрлиц для Select в форме клиента.
 * Доступен ADMIN и MANAGER (менеджеры заполняют реквизиты клиентов).
 * settings/legal-entities/actions.ts.listLegalEntities — ADMIN-only и тянет
 * все юрлица; здесь нам нужен только активный срез нужных полей.
 */
export async function listActiveOurLegalEntitiesForClientForm(): Promise<
  Array<{ id: string; shortName: string; entityType: 'INDIVIDUAL_ENTREPRENEUR' | 'LLC' }>
> {
  await requireRole(['ADMIN', 'MANAGER'])
  return prisma.ourLegalEntity.findMany({
    where: { isActive: true },
    orderBy: { shortName: 'asc' },
    select: { id: true, shortName: true, entityType: true },
  })
}

/**
 * Возвращает (или генерирует впервые) onboarding-токен и deep-link для клиента.
 * Идемпотентно: повторный вызов вернёт сохранённый токен.
 */
export async function ensureClientOnboardingToken(
  clientId: string
): Promise<ActionResult<{ token: string; deeplink: string }>> {
  await requireRole(['ADMIN', 'MANAGER'])

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, maxOnboardingToken: true },
  })
  if (!client) return { ok: false, error: 'Клиент не найден' }

  let token = client.maxOnboardingToken
  if (!token) {
    token = generateOnboardingToken()
    await prisma.client.update({
      where: { id: clientId },
      data: { maxOnboardingToken: token },
    })
  }

  revalidatePath(`/clients/${clientId}`)
  return { ok: true, data: { token, deeplink: buildOnboardingDeeplink(token) } }
}
