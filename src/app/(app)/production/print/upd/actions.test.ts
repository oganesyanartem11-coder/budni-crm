import { describe, it, expect, vi } from 'vitest'
import { Prisma } from '@prisma/client'

/**
 * Юнит-тесты строки «Услуги по доставке» в снапшоте УПД (Волна «доставка как
 * выручка»). Тестируем чистую buildSnapshots: модуль помечен 'use server' и
 * тянет prisma/auth — мокаем их, чтобы импорт был безопасным и тест оставался
 * чисто-функциональным (никаких обращений к БД).
 */
vi.mock('@/lib/db/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/auth/current-user', () => ({ requireRole: vi.fn() }))
vi.mock('@/lib/upd/document-number', () => ({ getNextDocumentNumber: vi.fn() }))

import { buildSnapshots } from './build-snapshots'

type OrderFull = Parameters<typeof buildSnapshots>[0][number]

const SUPPLIER = {
  shortName: 'ООО Будни',
  fullName: 'Общество с ограниченной ответственностью «Будни»',
  entityType: 'ORGANIZATION',
  inn: '7700000000',
  kpp: '770001001',
  ogrn: '1franchise',
  legalAddress: 'Москва',
  phone: null,
  email: null,
  bankName: 'Банк',
  bankBic: '044525000',
  bankAccount: '40702810000000000000',
  bankCorrAccount: '30101810000000000000',
  directorName: 'Иванов И.И.',
  directorPosition: 'Директор',
}

const CLIENT = {
  name: 'Сириус',
  legalName: 'ООО Сириус',
  inn: '7711111111',
  kpp: '771101001',
  ogrn: '2',
  legalAddress: 'Москва, Ленина 1',
  bankName: null,
  bankBic: null,
  bankAccount: null,
  bankCorrAccount: null,
  contractNumber: 'Д-1',
  contractDate: null,
}

function makeOrder(opts: {
  id: string
  portions: number
  pricePerPortion: string
  vatRate: string | null
  deliveryFee: string | null
}): OrderFull {
  const price = new Prisma.Decimal(opts.pricePerPortion)
  const total = price.mul(opts.portions)
  return {
    id: opts.id,
    clientId: 'cl_1',
    locationId: 'loc_1',
    mealType: 'LUNCH',
    deliveryDate: new Date('2026-06-05T00:00:00.000Z'),
    portions: opts.portions,
    pricePerPortion: price,
    totalPrice: total,
    vatRate: opts.vatRate == null ? null : new Prisma.Decimal(opts.vatRate),
    ourLegalEntityId: 'le_1',
    ourLegalEntity: SUPPLIER,
    client: CLIENT,
    location: {
      name: 'Точка на Ленина',
      address: 'Ленина 1',
      deliveryFee:
        opts.deliveryFee == null ? null : new Prisma.Decimal(opts.deliveryFee),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('buildSnapshots — строка «Услуги по доставке»', () => {
  it('добавляет строку доставки с НДС по ставке УПД и складывает в тоталы', () => {
    // 2 заказа еды по 100 порций × 350 = 35 000 каждый (всего 70 000),
    // ставка НДС 20%, доставка 500.
    const orders = [
      makeOrder({ id: 'o1', portions: 100, pricePerPortion: '350.00', vatRate: '20.00', deliveryFee: '500.00' }),
      makeOrder({ id: 'o2', portions: 100, pricePerPortion: '350.00', vatRate: '20.00', deliveryFee: '500.00' }),
    ]
    const snap = buildSnapshots(orders)

    // 3 строки: 2 еды + 1 доставка.
    expect(snap.linesSnapshot).toHaveLength(3)
    const delivery = snap.linesSnapshot.find((l) => l.kind === 'DELIVERY')
    expect(delivery).toBeDefined()
    expect(delivery!.orderId).toBe('delivery-loc_1')
    expect(delivery!.portions).toBe(1)
    expect(delivery!.pricePerPortion).toBe('500.00')
    expect(delivery!.lineTotal).toBe('500.00')
    // НДС наследует ставку 20% — как у еды (calculateUpdAmounts): 500*20/120 = 83.33
    expect(delivery!.lineVat).toBe('83.33')
    expect(delivery!.lineTotalWithoutVat).toBe('416.67')
    // строка доставки не несёт meal-полей
    expect(delivery!.mealLabel).toBeUndefined()
    expect(delivery!.deliveryDateIso).toBeUndefined()

    // Тоталы включают доставку: 70 000 + 500 = 70 500.
    expect(snap.totalAmount.toFixed(2)).toBe('70500.00')
    // НДС еды: каждая 35000*20/120 = 5833.33 → 11666.66; + доставка 83.33 = 11749.99
    expect(snap.vatAmount!.toFixed(2)).toBe('11749.99')
    expect(snap.amountWithoutVat.toFixed(2)).toBe(
      snap.totalAmount.sub(snap.vatAmount!).toFixed(2)
    )
  })

  it('deliveryFee=null → строки доставки нет, тоталы как раньше (бэквард-совместимость)', () => {
    const withFee = buildSnapshots([
      makeOrder({ id: 'o1', portions: 100, pricePerPortion: '350.00', vatRate: '20.00', deliveryFee: '500.00' }),
    ])
    const noFee = buildSnapshots([
      makeOrder({ id: 'o1', portions: 100, pricePerPortion: '350.00', vatRate: '20.00', deliveryFee: null }),
    ])

    // null → только строка еды, без доставки.
    expect(noFee.linesSnapshot).toHaveLength(1)
    expect(noFee.linesSnapshot.find((l) => l.kind === 'DELIVERY')).toBeUndefined()

    // Тоталы noFee == чистая еда (35 000), и строго меньше, чем withFee.
    expect(noFee.totalAmount.toFixed(2)).toBe('35000.00')
    expect(withFee.totalAmount.toFixed(2)).toBe('35500.00')
  })

  it('deliveryFee=0 → строки доставки нет (нулевую позицию не плодим)', () => {
    const snap = buildSnapshots([
      makeOrder({ id: 'o1', portions: 10, pricePerPortion: '300.00', vatRate: '20.00', deliveryFee: '0.00' }),
    ])
    expect(snap.linesSnapshot).toHaveLength(1)
    expect(snap.totalAmount.toFixed(2)).toBe('3000.00')
  })

  it('vatRate=null → доставка без НДС, как и еда', () => {
    const snap = buildSnapshots([
      makeOrder({ id: 'o1', portions: 10, pricePerPortion: '300.00', vatRate: null, deliveryFee: '500.00' }),
    ])
    const delivery = snap.linesSnapshot.find((l) => l.kind === 'DELIVERY')!
    expect(delivery.lineVat).toBeNull()
    expect(delivery.lineTotalWithoutVat).toBe('500.00')
    expect(snap.vatAmount).toBeNull()
    expect(snap.totalAmount.toFixed(2)).toBe('3500.00')
  })
})
