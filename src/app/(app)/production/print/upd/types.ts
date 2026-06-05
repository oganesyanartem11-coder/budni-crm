// Структура JSON-снапшотов, замораживаемых в UpdDocument при формировании.
// Перепечатка читает только их (а не живые данные), поэтому изменения
// клиента/юрлица/точки после генерации не влияют на УПД.

import type { LegalEntityType, MealType } from '@prisma/client'

export interface UpdSupplierSnapshot {
  shortName: string
  fullName: string
  entityType: LegalEntityType
  inn: string
  kpp: string | null
  ogrn: string
  legalAddress: string
  phone: string | null
  email: string | null
  bankName: string
  bankBic: string
  bankAccount: string
  bankCorrAccount: string
  directorName: string
  directorPosition: string
}

export interface UpdBuyerSnapshot {
  clientName: string
  legalName: string | null
  inn: string | null
  kpp: string | null
  ogrn: string | null
  legalAddress: string | null
  bankName: string | null
  bankBic: string | null
  bankAccount: string | null
  bankCorrAccount: string | null
  contractNumber: string | null
  contractDateIso: string | null
  locationName: string
  locationAddress: string
}

// Все денежные значения — строки (Decimal сериализуется в string).
//
// Строка бывает двух видов (Волна «доставка как выручка»):
//  - kind отсутствует или 'FOOD' — обычная позиция «обеды» (по одному заказу).
//    Заполнены mealType/mealLabel/deliveryDateIso (привязка к Order).
//  - kind === 'DELIVERY' — агрегированная строка «Услуги по доставке» (одна на
//    УПД, привязки к заказу нет). orderId — синтетический ключ delivery-<loc>,
//    mealType/mealLabel/deliveryDateIso отсутствуют.
// БЭКВАРД-СОВМЕСТИМОСТЬ: старые персистентные снапшоты не имеют поля kind и
// всегда содержат заполненные mealType/mealLabel/deliveryDateIso — они парсятся
// как FOOD без изменений. Поэтому order-поля сделаны опциональными, а не убраны.
export interface UpdLineSnapshot {
  kind?: 'FOOD' | 'DELIVERY'
  orderId: string
  mealType?: MealType
  mealLabel?: string
  deliveryDateIso?: string
  portions: number
  pricePerPortion: string
  lineTotal: string
  lineTotalWithoutVat: string
  lineVat: string | null
}
