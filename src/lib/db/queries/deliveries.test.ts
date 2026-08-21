import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const { mockFindMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    order: { findMany: mockFindMany },
  },
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/app/(app)/delivery/actions', () => ({
  markStopDelivered: vi.fn(),
  undoStopDelivered: vi.fn(),
}))
vi.mock('@/app/(app)/delivery/_components/issue-dialog', () => ({
  IssueDialog: () => null,
}))

import { getDeliveriesForDate } from './deliveries'
import { DeliveryView } from '@/app/(app)/delivery/delivery-view'
import type { DeliveryStop } from './deliveries'

describe('getDeliveriesForDate authorization', () => {
  beforeEach(() => {
    mockFindMany.mockReset()
    mockFindMany.mockResolvedValue([])
  })

  it('limits a courier to locations explicitly assigned to that courier', async () => {
    await getDeliveriesForDate(new Date('2026-08-07T12:00:00.000Z'), {
      id: 'courier-own',
      role: 'COURIER',
    })

    expect(mockFindMany).toHaveBeenCalledOnce()
    expect(mockFindMany.mock.calls[0]?.[0]?.where).toMatchObject({
      location: { assignedCourierId: 'courier-own' },
    })
    expect(mockFindMany.mock.calls[0]?.[0]?.where.location).not.toHaveProperty('OR')
  })

  it.each(['ADMIN_PRO', 'ADMIN', 'MANAGER'] as const)(
    'allows %s to read all delivery locations',
    async (role) => {
      await getDeliveriesForDate(new Date('2026-08-07T12:00:00.000Z'), {
        id: 'manager-1',
        role,
      })

      expect(mockFindMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('location')
    },
  )

  it('denies CHEF before querying delivery data', async () => {
    await expect(
      getDeliveriesForDate(new Date('2026-08-07T12:00:00.000Z'), {
        id: 'chef-1',
        role: 'CHEF',
      }),
    ).rejects.toThrow('Остановка недоступна или не найдена')

    expect(mockFindMany).not.toHaveBeenCalled()
  })
})

describe('getDeliveriesForDate delivery contact fields', () => {
  beforeEach(() => {
    mockFindMany.mockReset()
    mockFindMany.mockResolvedValue([])
  })

  it('loads complete contact candidates and location delivery instructions', async () => {
    await getDeliveriesForDate(new Date('2026-08-07T12:00:00.000Z'), {
      id: 'manager-1',
      role: 'MANAGER',
    })

    const include = mockFindMany.mock.calls[0]?.[0]?.include
    expect(include.client.select).toMatchObject({
      id: true,
      name: true,
      contactName: true,
      contactPhone: true,
    })
    expect(include.client.select.contacts).toEqual({
      select: {
        id: true,
        clientId: true,
        locationId: true,
        isPrimaryForDelivery: true,
        name: true,
        phone: true,
        notes: true,
        sortOrder: true,
        createdAt: true,
      },
    })
    expect(include.location.select.deliveryInstructions).toBe(true)
  })

  it('maps the location-primary contact and delivery instructions into the stop', async () => {
    const createdAt = new Date('2026-08-07T09:00:00.000Z')
    mockFindMany.mockResolvedValue([
      {
        id: 'order-1',
        clientId: 'client-1',
        locationId: 'location-1',
        mealType: 'LUNCH',
        portions: 12,
        packaging: 'INDIVIDUAL',
        updatedAt: createdAt,
        status: 'CONFIRMED',
        lateAlertSentAt: null,
        notes: null,
        client: {
          id: 'client-1',
          name: 'Клиент',
          contactName: 'Legacy',
          contactPhone: '+70000000000',
          contacts: [
            {
              id: 'client-wide',
              clientId: 'client-1',
              locationId: null,
              isPrimaryForDelivery: false,
              name: 'Общий',
              phone: '+71111111111',
              notes: null,
              sortOrder: 0,
              createdAt,
            },
            {
              id: 'location-first',
              clientId: 'client-1',
              locationId: 'location-1',
              isPrimaryForDelivery: false,
              name: 'Первый по сортировке',
              phone: '+72222222222',
              notes: null,
              sortOrder: 1,
              createdAt,
            },
            {
              id: 'location-primary',
              clientId: 'client-1',
              locationId: 'location-1',
              isPrimaryForDelivery: true,
              name: 'Основной на точке',
              phone: '+73333333333',
              notes: 'Позвонить за десять минут',
              sortOrder: 20,
              createdAt,
            },
          ],
        },
        location: {
          id: 'location-1',
          name: 'Склад',
          address: 'ул. Тестовая, 1',
          deliveryWindowFrom: '12:00',
          deliveryWindowTo: '13:00',
          tags: [],
          deliveryInstructions: 'Въезд через вторые ворота',
        },
        delivery: null,
      },
    ])

    const [stop] = await getDeliveriesForDate(
      new Date('2026-08-07T12:00:00.000Z'),
      { id: 'manager-1', role: 'MANAGER' },
    )

    expect(stop).toMatchObject({
      clientContactName: 'Основной на точке',
      clientContactPhone: '+73333333333',
      clientContactNotes: 'Позвонить за десять минут',
      deliveryInstructions: 'Въезд через вторые ворота',
    })
  })
})

describe('DeliveryView contact details', () => {
  it('renders the resolved contact notes and delivery instructions on an active card', () => {
    const stop: DeliveryStop = {
      clientId: 'client-1',
      clientName: 'Клиент',
      clientContactName: 'Основной на точке',
      clientContactPhone: '+73333333333',
      clientContactNotes: 'Позвонить за десять минут',
      locationId: 'location-1',
      locationName: 'Склад',
      locationAddress: 'ул. Тестовая, 1',
      deliveryInstructions: 'Въезд через вторые ворота',
      deliveryWindowFrom: null,
      deliveryWindowTo: null,
      tags: [],
      notes: null,
      totalPortions: 12,
      items: [{
        orderId: 'order-1',
        mealType: 'LUNCH',
        portions: 12,
        packaging: 'INDIVIDUAL',
        updatedAt: new Date('2026-08-07T09:00:00.000Z'),
      }],
      isDelivered: false,
      deliveredAt: null,
      orderIds: ['order-1'],
      hasOutForDelivery: false,
      hasLateAlert: false,
      issueReportedAt: null,
      issueReason: null,
      issueComment: null,
    }

    const html = renderToStaticMarkup(createElement(DeliveryView, {
      stops: [stop],
      targetDateIso: '2026-08-07T00:00:00.000Z',
      userRole: 'MANAGER',
    }))

    expect(html).toContain('Основной на точке')
    expect(html).toContain('+73333333333')
    expect(html).toContain('Позвонить за десять минут')
    expect(html).toContain('Въезд через вторые ворота')
  })
})
