import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import {
  DeliveryStopAccessError,
  type DeliveryActor,
  type LegacyStopOrder,
} from './legacy-stop'
import {
  DeliveryUndoTtlError,
  markLegacyStopDeliveredInTransaction,
  reportLegacyStopIssueInTransaction,
  undoLegacyStopDeliveredInTransaction,
} from './legacy-stop-mutations'

const now = new Date('2026-08-07T10:00:00.000Z')
const manager: DeliveryActor = { id: 'manager-1', role: 'MANAGER', name: 'Менеджер' }

function row(over: Partial<LegacyStopOrder> = {}): LegacyStopOrder {
  return {
    id: over.id ?? 'order-1',
    routeStopId: over.routeStopId ?? null,
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
      assignedCourierId: null,
      deliveryWindowFrom: null,
      deliveryWindowTo: null,
    },
    delivery: over.delivery === undefined ? null : over.delivery,
  }
}

function mockTx(selected: LegacyStopOrder[], complete = selected) {
  return {
    order: {
      findMany: vi.fn().mockResolvedValueOnce(selected).mockResolvedValueOnce(complete),
      update: vi.fn().mockResolvedValue({}),
    },
    delivery: {
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
  }
}

describe('legacy stop transaction mutations', () => {
  it('makes a repeated delivered mutation idempotent', async () => {
    const delivered = row({
      status: 'DELIVERED',
      delivery: {
        id: 'delivery-1',
        courierName: 'Курьер',
        deliveredAt: new Date('2026-08-07T09:55:00.000Z'),
      },
    })
    const tx = mockTx([delivered])

    const result = await markLegacyStopDeliveredInTransaction(
      tx as unknown as Prisma.TransactionClient,
      { actor: manager, orderIds: ['order-1'], expectedUpdatedAts: undefined, now },
    )

    expect(result.updated).toBe(0)
    expect(tx.order.update).not.toHaveBeenCalled()
    expect(tx.delivery.update).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('updates every active order and legacy delivery and logs inside the transaction', async () => {
    const first = row({
      delivery: { id: 'delivery-1', courierName: null, deliveredAt: null },
    })
    const second = row({ id: 'order-2', status: 'CONFIRMED', mealType: 'DINNER' })
    const tx = mockTx([first, second])

    const result = await markLegacyStopDeliveredInTransaction(
      tx as unknown as Prisma.TransactionClient,
      {
        actor: manager,
        orderIds: ['order-1', 'order-2'],
        expectedUpdatedAts: {
          'order-1': first.updatedAt.toISOString(),
          'order-2': second.updatedAt.toISOString(),
        },
        now,
      },
    )

    expect(result.updated).toBe(2)
    expect(tx.order.update).toHaveBeenCalledTimes(2)
    expect(tx.delivery.update).toHaveBeenCalledOnce()
    expect(tx.delivery.create).toHaveBeenCalledOnce()
    expect(tx.activityLog.create).toHaveBeenCalledOnce()
  })

  it('rejects a materialized stop in the legacy completion transaction', async () => {
    const materialized = row({ routeStopId: 'route-stop-1' })
    const tx = mockTx([materialized])

    await expect(markLegacyStopDeliveredInTransaction(
      tx as unknown as Prisma.TransactionClient,
      {
        actor: manager,
        orderIds: ['order-1'],
        expectedUpdatedAts: { 'order-1': materialized.updatedAt.toISOString() },
        now,
      },
    )).rejects.toBeInstanceOf(DeliveryStopAccessError)

    expect(tx.order.update).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('writes an issue and its activity log for the complete stop', async () => {
    const first = row({ delivery: { id: 'delivery-1', courierName: null, deliveredAt: null } })
    const second = row({ id: 'order-2', mealType: 'DINNER' })
    const tx = mockTx([first, second])

    const result = await reportLegacyStopIssueInTransaction(
      tx as unknown as Prisma.TransactionClient,
      {
        actor: manager,
        orderIds: ['order-1', 'order-2'],
        reason: 'CLIENT_UNAVAILABLE',
        comment: 'Нет на месте',
        now,
      },
    )

    expect(result.updated).toBe(2)
    expect(tx.delivery.update).toHaveBeenCalledOnce()
    expect(tx.delivery.create).toHaveBeenCalledOnce()
    expect(tx.activityLog.create).toHaveBeenCalledOnce()
  })

  it('denies undo when any delivery timestamp is missing or older than one hour', async () => {
    const recent = row({
      status: 'DELIVERED',
      delivery: {
        id: 'delivery-1',
        courierName: 'Курьер',
        deliveredAt: new Date('2026-08-07T09:50:00.000Z'),
      },
    })
    const old = row({
      id: 'order-2',
      status: 'DELIVERED',
      delivery: {
        id: 'delivery-2',
        courierName: 'Курьер',
        deliveredAt: new Date('2026-08-07T08:00:00.000Z'),
      },
    })

    await expect(
      undoLegacyStopDeliveredInTransaction(
        mockTx([recent, old]) as unknown as Prisma.TransactionClient,
        { actor: manager, orderIds: ['order-1', 'order-2'], now },
      ),
    ).rejects.toBeInstanceOf(DeliveryUndoTtlError)

    const missing = row({
      id: 'order-2',
      status: 'DELIVERED',
      delivery: { id: 'delivery-2', courierName: 'Курьер', deliveredAt: null },
    })
    await expect(
      undoLegacyStopDeliveredInTransaction(
        mockTx([recent, missing]) as unknown as Prisma.TransactionClient,
        { actor: manager, orderIds: ['order-1', 'order-2'], now },
      ),
    ).rejects.toBeInstanceOf(DeliveryUndoTtlError)
  })

  it('does not let legacy undo desynchronize a Delivery 2.0 stop', async () => {
    const delivered = row({
      routeStopId: 'route-stop-1',
      status: 'DELIVERED',
      delivery: {
        id: 'delivery-1',
        courierName: 'Курьер',
        deliveredAt: new Date('2026-08-07T09:50:00.000Z'),
      },
    })
    const tx = mockTx([delivered])

    await expect(undoLegacyStopDeliveredInTransaction(
      tx as unknown as Prisma.TransactionClient,
      { actor: manager, orderIds: ['order-1'], now },
    )).rejects.toBeInstanceOf(DeliveryStopAccessError)

    expect(tx.order.update).not.toHaveBeenCalled()
  })
})
