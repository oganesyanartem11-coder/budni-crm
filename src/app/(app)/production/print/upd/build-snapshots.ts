import { Prisma } from '@prisma/client'
import { calculateUpdAmounts } from '@/lib/upd/vat-calc'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import type {
  UpdSupplierSnapshot,
  UpdBuyerSnapshot,
  UpdLineSnapshot,
} from './types'

// Заказ с подгруженными связями, нужными для группировки и снапшотов.
export type OrderFull = Prisma.OrderGetPayload<{
  include: { client: true; location: true; ourLegalEntity: true }
}>

// Сборка снапшотов поставщика/покупателя/строк из подгруженных Order'ов одной группы.
// Вынесено из actions.ts ('use server' допускает только async-экспорты) — это
// чистая синхронная функция, поэтому живёт в обычном модуле и юнит-тестируется.
export function buildSnapshots(orders: OrderFull[]): {
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
      kind: 'FOOD',
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

  // Строка «Услуги по доставке» (Волна «доставка как выручка»). Одна
  // агрегированная позиция на УПД: доставка стоит ОДИН раз на (локация, день),
  // а не на каждый mealType-заказ. Добавляем только если у точки задан
  // deliveryFee > 0 И есть хотя бы одна строка еды (пустую УПД не плодим).
  // НДС наследует ставку УПД (ставка еды) — через тот же calculateUpdAmounts,
  // что и для еды. deliveryFee = null трактуется как бесплатная доставка → строки
  // нет, тоталы идентичны прежним (полная обратная совместимость).
  const deliveryFee = location.deliveryFee
  if (deliveryFee != null && deliveryFee.gt(0) && orders.length > 0) {
    const amounts = calculateUpdAmounts(new Prisma.Decimal(deliveryFee), vatRate)
    linesSnapshot.push({
      kind: 'DELIVERY',
      orderId: `delivery-${first.locationId}`,
      portions: 1,
      pricePerPortion: deliveryFee.toFixed(2),
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
