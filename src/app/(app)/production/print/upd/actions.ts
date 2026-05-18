'use server'

import { Prisma } from '@prisma/client'
import type { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { calculateUpdAmounts } from '@/lib/upd/vat-calc'
import { getNextDocumentNumber } from '@/lib/upd/document-number'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import type {
  UpdSupplierSnapshot,
  UpdBuyerSnapshot,
  UpdLineSnapshot,
} from './types'

const PRODUCTION_STATUSES: OrderStatus[] = [
  'CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY',
]

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

function dayRange(dateIso: string): { from: Date; to: Date } | null {
  // Order.deliveryDate — @db.Date, Prisma отдаёт UTC midnight. Фильтруем строго
  // по UTC-границам календарного дня, чтобы TZ сервера не сдвигала окно.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(dateIso)
  if (!m) return null
  const ymd = m[1]
  const from = new Date(ymd + 'T00:00:00.000Z')
  const to = new Date(ymd + 'T23:59:59.999Z')
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null
  return { from, to }
}

// Заказ с подгруженными связями, нужными для группировки и снапшотов.
type OrderFull = Prisma.OrderGetPayload<{
  include: { client: true; location: true; ourLegalEntity: true }
}>

// Сборка снапшотов поставщика/покупателя/строк из подгруженных Order'ов одной группы.
function buildSnapshots(orders: OrderFull[]): {
  supplierSnapshot: UpdSupplierSnapshot
  buyerSnapshot: UpdBuyerSnapshot
  linesSnapshot: UpdLineSnapshot[]
  totalAmount: Prisma.Decimal
  vatAmount: Prisma.Decimal | null
  amountWithoutVat: Prisma.Decimal
  vatRate: Prisma.Decimal | null
} {
  const first = orders[0]
  const supplier = first.ourLegalEntity!
  const client = first.client
  const location = first.location
  // vatRate берётся из snapshot'а заказа (Sprint 7b-2). Все заказы группы
  // делят одно юрлицо отгрузки, поэтому ставка одинакова.
  const vatRate = first.vatRate

  const supplierSnapshot: UpdSupplierSnapshot = {
    shortName: supplier.shortName,
    fullName: supplier.fullName,
    entityType: supplier.entityType,
    inn: supplier.inn,
    kpp: supplier.kpp,
    ogrn: supplier.ogrn,
    legalAddress: supplier.legalAddress,
    phone: supplier.phone,
    email: supplier.email,
    bankName: supplier.bankName,
    bankBic: supplier.bankBic,
    bankAccount: supplier.bankAccount,
    bankCorrAccount: supplier.bankCorrAccount,
    directorName: supplier.directorName,
    directorPosition: supplier.directorPosition,
  }

  const buyerSnapshot: UpdBuyerSnapshot = {
    clientName: client.name,
    legalName: client.legalName,
    inn: client.inn,
    kpp: client.kpp,
    ogrn: client.ogrn,
    legalAddress: client.legalAddress,
    bankName: client.bankName,
    bankBic: client.bankBic,
    bankAccount: client.bankAccount,
    bankCorrAccount: client.bankCorrAccount,
    contractNumber: client.contractNumber,
    contractDateIso: client.contractDate ? client.contractDate.toISOString() : null,
    locationName: location.name,
    locationAddress: location.address,
  }

  const linesSnapshot: UpdLineSnapshot[] = []
  let totalSum = new Prisma.Decimal(0)
  let vatSum = new Prisma.Decimal(0)
  let withoutVatSum = new Prisma.Decimal(0)

  for (const o of orders) {
    const amounts = calculateUpdAmounts(o.totalPrice, vatRate)
    linesSnapshot.push({
      orderId: o.id,
      mealType: o.mealType,
      mealLabel: MEAL_TYPE_LABELS[o.mealType],
      deliveryDateIso: o.deliveryDate.toISOString(),
      portions: o.portions,
      pricePerPortion: o.pricePerPortion.toFixed(2),
      lineTotal: amounts.totalAmount.toFixed(2),
      lineTotalWithoutVat: amounts.amountWithoutVat.toFixed(2),
      lineVat: amounts.vatAmount ? amounts.vatAmount.toFixed(2) : null,
    })
    totalSum = totalSum.add(amounts.totalAmount)
    withoutVatSum = withoutVatSum.add(amounts.amountWithoutVat)
    if (amounts.vatAmount) vatSum = vatSum.add(amounts.vatAmount)
  }

  return {
    supplierSnapshot,
    buyerSnapshot,
    linesSnapshot,
    totalAmount: totalSum,
    vatAmount: vatRate ? vatSum : null,
    amountWithoutVat: withoutVatSum,
    vatRate,
  }
}

export interface UpdPreviewGroup {
  key: string // ourLegalEntityId|clientId|locationId
  ourLegalEntityId: string
  ourLegalEntityShortName: string
  clientId: string
  clientName: string
  locationId: string
  locationName: string
  locationAddress: string
  ordersCount: number
  totalPortions: number
  totalAmount: string
  vatAmount: string | null
  vatRate: string | null
  alreadyGenerated: boolean
  existingDocumentNumber: string | null
  existingDocumentId: string | null
  meals: Array<{ mealType: string; portions: number; mealLabel: string }>
}

export interface UpdUnassignedOrder {
  orderId: string
  clientName: string
  locationName: string
  mealType: string
  mealLabel: string
  portions: number
}

export interface UpdPreviewResult {
  date: string
  groups: UpdPreviewGroup[]
  unassignedOrders: UpdUnassignedOrder[]
}

export async function previewUpdForDate(
  dateIso: string
): Promise<ActionResult<UpdPreviewResult>> {
  await requireRole(['ADMIN', 'MANAGER'])
  const range = dayRange(dateIso)
  if (!range) return { ok: false, error: 'Неверная дата' }

  const orders = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: range.from, lte: range.to },
      status: { in: PRODUCTION_STATUSES },
    },
    include: { client: true, location: true, ourLegalEntity: true },
    orderBy: [{ clientId: 'asc' }, { locationId: 'asc' }, { mealType: 'asc' }],
  })

  const unassignedOrders: UpdUnassignedOrder[] = []
  const groupsMap = new Map<string, OrderFull[]>()
  for (const o of orders) {
    if (!o.ourLegalEntityId || !o.ourLegalEntity) {
      unassignedOrders.push({
        orderId: o.id,
        clientName: o.client.name,
        locationName: o.location.name,
        mealType: o.mealType,
        mealLabel: MEAL_TYPE_LABELS[o.mealType],
        portions: o.portions,
      })
      continue
    }
    const key = `${o.ourLegalEntityId}|${o.clientId}|${o.locationId}`
    if (!groupsMap.has(key)) groupsMap.set(key, [])
    groupsMap.get(key)!.push(o)
  }

  // Существующие УПД по бизнес-ключу — батчем
  const existingDocs = await prisma.updDocument.findMany({
    where: {
      deliveryDate: { gte: range.from, lte: range.to },
      OR: Array.from(groupsMap.values()).map((arr) => ({
        ourLegalEntityId: arr[0].ourLegalEntityId!,
        clientId: arr[0].clientId,
        locationId: arr[0].locationId,
      })),
    },
    select: {
      id: true, documentNumber: true,
      ourLegalEntityId: true, clientId: true, locationId: true,
    },
  })
  const existingMap = new Map<string, { id: string; documentNumber: string }>()
  for (const d of existingDocs) {
    existingMap.set(`${d.ourLegalEntityId}|${d.clientId}|${d.locationId}`, {
      id: d.id, documentNumber: d.documentNumber,
    })
  }

  const groups: UpdPreviewGroup[] = []
  for (const [key, arr] of groupsMap) {
    const first = arr[0]
    const totals = buildSnapshots(arr)
    const existing = existingMap.get(key)
    const mealsAggregate = new Map<string, { portions: number; mealLabel: string }>()
    for (const o of arr) {
      const m = mealsAggregate.get(o.mealType) ?? { portions: 0, mealLabel: MEAL_TYPE_LABELS[o.mealType] }
      m.portions += o.portions
      mealsAggregate.set(o.mealType, m)
    }
    groups.push({
      key,
      ourLegalEntityId: first.ourLegalEntityId!,
      ourLegalEntityShortName: first.ourLegalEntity!.shortName,
      clientId: first.clientId,
      clientName: first.client.name,
      locationId: first.locationId,
      locationName: first.location.name,
      locationAddress: first.location.address,
      ordersCount: arr.length,
      totalPortions: arr.reduce((s, o) => s + o.portions, 0),
      totalAmount: totals.totalAmount.toFixed(2),
      vatAmount: totals.vatAmount ? totals.vatAmount.toFixed(2) : null,
      vatRate: totals.vatRate ? totals.vatRate.toFixed(2) : null,
      alreadyGenerated: !!existing,
      existingDocumentNumber: existing?.documentNumber ?? null,
      existingDocumentId: existing?.id ?? null,
      meals: Array.from(mealsAggregate.entries()).map(([mealType, v]) => ({
        mealType, portions: v.portions, mealLabel: v.mealLabel,
      })),
    })
  }

  return { ok: true, data: { date: dateIso, groups, unassignedOrders } }
}

export interface UpdGenerateResult {
  date: string
  printUrl: string
  createdCount: number
  reusedCount: number
  conflicts: Array<{ orderId: string; reason: string }>
}

export async function generateAndGetUpdForDate(
  dateIso: string
): Promise<ActionResult<UpdGenerateResult>> {
  const me = await requireRole(['ADMIN', 'MANAGER'])
  const range = dayRange(dateIso)
  if (!range) return { ok: false, error: 'Неверная дата' }

  const orders = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: range.from, lte: range.to },
      status: { in: PRODUCTION_STATUSES },
      ourLegalEntityId: { not: null },
    },
    include: { client: true, location: true, ourLegalEntity: true },
  })

  const groupsMap = new Map<string, OrderFull[]>()
  for (const o of orders) {
    if (!o.ourLegalEntityId) continue
    const key = `${o.ourLegalEntityId}|${o.clientId}|${o.locationId}`
    if (!groupsMap.has(key)) groupsMap.set(key, [])
    groupsMap.get(key)!.push(o)
  }

  let createdCount = 0
  let reusedCount = 0
  const conflicts: Array<{ orderId: string; reason: string }> = []

  for (const arr of groupsMap.values()) {
    const first = arr[0]
    const businessKey = {
      upd_business_key: {
        ourLegalEntityId: first.ourLegalEntityId!,
        clientId: first.clientId,
        locationId: first.locationId,
        deliveryDate: range.from,
      },
    }

    // Идемпотентность: существует — пропускаем (номер не пере-присваивается)
    const existing = await prisma.updDocument.findUnique({
      where: businessKey,
      select: { id: true },
    })
    if (existing) {
      reusedCount++
      continue
    }

    // Отсекаем заказы, уже привязанные к другим УПД (например, после
    // changeOrderLegalEntity старая УПД осталась)
    const alreadyLinked = await prisma.updDocumentOrder.findMany({
      where: { orderId: { in: arr.map((o) => o.id) } },
      select: { orderId: true },
    })
    const linkedIds = new Set(alreadyLinked.map((l) => l.orderId))
    const freeOrders = arr.filter((o) => !linkedIds.has(o.id))
    for (const o of arr) {
      if (linkedIds.has(o.id)) {
        conflicts.push({ orderId: o.id, reason: 'Заказ уже в другой УПД' })
      }
    }
    if (freeOrders.length === 0) continue

    const snap = buildSnapshots(freeOrders)

    try {
      await prisma.$transaction(async (tx) => {
        const { documentNumber, number, year } = await getNextDocumentNumber(
          tx, first.ourLegalEntityId!
        )
        const created = await tx.updDocument.create({
          data: {
            number, year, documentNumber,
            ourLegalEntityId: first.ourLegalEntityId!,
            clientId: first.clientId,
            locationId: first.locationId,
            deliveryDate: range.from,
            supplierSnapshot: snap.supplierSnapshot as unknown as Prisma.InputJsonValue,
            buyerSnapshot: snap.buyerSnapshot as unknown as Prisma.InputJsonValue,
            linesSnapshot: snap.linesSnapshot as unknown as Prisma.InputJsonValue,
            totalAmount: snap.totalAmount,
            vatRate: snap.vatRate,
            vatAmount: snap.vatAmount,
            amountWithoutVat: snap.amountWithoutVat,
            generatedById: me.id,
          },
        })
        await tx.updDocumentOrder.createMany({
          data: freeOrders.map((o) => ({
            updDocumentId: created.id, orderId: o.id,
          })),
        })
        await tx.activityLog.create({
          data: {
            userId: me.id,
            userRole: me.role,
            action: 'UPD_GENERATED',
            entityType: 'UpdDocument',
            entityId: created.id,
            payload: {
              documentNumber,
              ourLegalEntityId: first.ourLegalEntityId,
              clientId: first.clientId,
              locationId: first.locationId,
              deliveryDate: dateIso,
              orderIds: freeOrders.map((o) => o.id),
              totalAmount: snap.totalAmount.toFixed(2),
            },
          },
        })
      })
      createdCount++
    } catch (err) {
      // Гонка: пока считали — кто-то создал. P2002 либо на бизнес-ключе УПД,
      // либо на one_upd_per_order. В обоих случаях считаем "переиспользовано".
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        reusedCount++
        for (const o of freeOrders) {
          conflicts.push({ orderId: o.id, reason: 'Гонка при создании УПД (P2002)' })
        }
        continue
      }
      throw err
    }
  }

  return {
    ok: true,
    data: {
      date: dateIso,
      printUrl: `/production/print/upd/view?date=${dateIso}`,
      createdCount,
      reusedCount,
      conflicts,
    },
  }
}

export interface UpdListItem {
  id: string
  documentNumber: string
  deliveryDateIso: string
  createdAtIso: string
  ourLegalEntityShortName: string
  clientId: string
  clientName: string
  locationName: string
  totalAmount: string
}

export async function listGeneratedUpd(filter: {
  dateFrom?: string
  dateTo?: string
  clientId?: string
}): Promise<ActionResult<{ items: UpdListItem[]; truncated: boolean }>> {
  await requireRole(['ADMIN', 'MANAGER'])

  const where: Prisma.UpdDocumentWhereInput = {}
  if (filter.dateFrom || filter.dateTo) {
    const dateFilter: Prisma.DateTimeFilter = {}
    if (filter.dateFrom) {
      const r = dayRange(filter.dateFrom)
      if (r) dateFilter.gte = r.from
    }
    if (filter.dateTo) {
      const r = dayRange(filter.dateTo)
      if (r) dateFilter.lte = r.to
    }
    where.deliveryDate = dateFilter
  }
  if (filter.clientId) where.clientId = filter.clientId

  const LIMIT = 100
  const docs = await prisma.updDocument.findMany({
    where,
    include: {
      ourLegalEntity: { select: { shortName: true } },
      client: { select: { name: true } },
      location: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: LIMIT + 1,
  })

  const truncated = docs.length > LIMIT
  const items: UpdListItem[] = docs.slice(0, LIMIT).map((d) => ({
    id: d.id,
    documentNumber: d.documentNumber,
    deliveryDateIso: d.deliveryDate.toISOString(),
    createdAtIso: d.createdAt.toISOString(),
    ourLegalEntityShortName: d.ourLegalEntity.shortName,
    clientId: d.clientId,
    clientName: d.client.name,
    locationName: d.location.name,
    totalAmount: d.totalAmount.toFixed(2),
  }))

  return { ok: true, data: { items, truncated } }
}
