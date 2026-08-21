import { describe, expect, it } from 'vitest'
import {
  DELIVERY_STOP_FORBIDDEN_ERROR,
  DeliveryStopVersionError,
  assertLegacyStopExpectedVersions,
  normalizeLegacyStopOrderIds,
  validateLegacyStopSnapshot,
  type LegacyStopOrder,
} from './legacy-stop'

function row(over: Partial<LegacyStopOrder> = {}): LegacyStopOrder {
  return {
    id: over.id ?? 'order-1',
    clientId: over.clientId ?? 'client-1',
    locationId: over.locationId ?? 'location-1',
    deliveryDate: over.deliveryDate ?? new Date('2026-08-07T00:00:00.000Z'),
    status: over.status ?? 'OUT_FOR_DELIVERY',
    updatedAt: over.updatedAt ?? new Date('2026-08-07T09:00:00.000Z'),
    portions: over.portions ?? 10,
    mealType: over.mealType ?? 'LUNCH',
    client: over.client ?? { name: 'Клиент' },
    location: over.location ?? {
      id: over.locationId ?? 'location-1',
      name: 'Точка',
      assignedCourierId: 'courier-own',
      deliveryWindowFrom: null,
      deliveryWindowTo: null,
    },
    delivery: over.delivery === undefined ? null : over.delivery,
  }
}

const courier = { id: 'courier-own', role: 'COURIER' as const, name: 'Курьер' }
const manager = { id: 'manager-1', role: 'MANAGER' as const, name: 'Менеджер' }

describe('legacy physical delivery stop validation', () => {
  it('normalizes unique non-empty order ids', () => {
    expect(normalizeLegacyStopOrderIds([' order-1 ', 'order-1', 'order-2'])).toEqual([
      'order-1',
      'order-2',
    ])
  })

  it.each([
    ['a whitespace-only id', ['valid-id', ' ']],
    ['a runtime non-string id', ['valid-id', 42] as unknown as string[]],
  ])('rejects the whole request containing %s', (_label, orderIds) => {
    expect(() => normalizeLegacyStopOrderIds(orderIds)).toThrow(
      DELIVERY_STOP_FORBIDDEN_ERROR,
    )
  })

  it('allows the courier assigned to the current location', () => {
    const orders = [row()]
    expect(validateLegacyStopSnapshot(['order-1'], orders, orders, courier)).toEqual(orders)
  })

  it.each([
    ['a foreign courier', 'courier-foreign'],
    ['an unassigned location', null],
  ])('denies %s without disclosing stop data', (_label, assignedCourierId) => {
    const orders = [row({ location: { ...row().location, assignedCourierId } })]
    expect(() => validateLegacyStopSnapshot(['order-1'], orders, orders, courier)).toThrow(
      DELIVERY_STOP_FORBIDDEN_ERROR,
    )
  })

  it.each(['ADMIN_PRO', 'ADMIN', 'MANAGER'] as const)('allows manager role %s', (role) => {
    const orders = [row({ location: { ...row().location, assignedCourierId: null } })]
    expect(
      validateLegacyStopSnapshot(['order-1'], orders, orders, { ...manager, role }),
    ).toEqual(orders)
  })

  it('denies CHEF', () => {
    const orders = [row()]
    expect(() =>
      validateLegacyStopSnapshot(
        ['order-1'],
        orders,
        orders,
        { id: 'chef-1', role: 'CHEF', name: 'Шеф' },
      ),
    ).toThrow(DELIVERY_STOP_FORBIDDEN_ERROR)
  })

  it('denies mixed locations', () => {
    const first = row()
    const second = row({
      id: 'order-2',
      locationId: 'location-2',
      location: { ...row().location, id: 'location-2' },
    })
    expect(() =>
      validateLegacyStopSnapshot(['order-1', 'order-2'], [first, second], [first, second], manager),
    ).toThrow(DELIVERY_STOP_FORBIDDEN_ERROR)
  })

  it('denies a missing order id', () => {
    const orders = [row()]
    expect(() =>
      validateLegacyStopSnapshot(['order-1', 'missing'], orders, orders, manager),
    ).toThrow(DELIVERY_STOP_FORBIDDEN_ERROR)
  })

  it('denies a partial physical stop', () => {
    const selected = [row()]
    const complete = [row(), row({ id: 'order-2', mealType: 'DINNER' })]
    expect(() => validateLegacyStopSnapshot(['order-1'], selected, complete, manager)).toThrow(
      DELIVERY_STOP_FORBIDDEN_ERROR,
    )
  })

  it('treats an already-delivered complete stop as idempotent without versions', () => {
    const orders = [row({ status: 'DELIVERED' })]
    expect(assertLegacyStopExpectedVersions(orders, undefined)).toEqual([])
  })

  it('requires an exact version for every non-delivered order', () => {
    const orders = [row()]
    expect(() => assertLegacyStopExpectedVersions(orders, undefined)).toThrow(
      DeliveryStopVersionError,
    )
    expect(() =>
      assertLegacyStopExpectedVersions(orders, { 'order-1': '2026-08-07T09:00:00.001Z' }),
    ).toThrow(DeliveryStopVersionError)
    expect(
      assertLegacyStopExpectedVersions(orders, {
        'order-1': '2026-08-07T09:00:00.000Z',
      }),
    ).toEqual(orders)
  })
})
