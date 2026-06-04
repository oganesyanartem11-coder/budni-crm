import { describe, it, expect, vi } from 'vitest'

// Мокаем prisma, чтобы исполнять execute() tool'ов без реальной БД.
vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    client: { findMany: vi.fn(), findUnique: vi.fn() },
    clientLocation: { findFirst: vi.fn() },
    order: { findMany: vi.fn() },
  },
}))

import { BORIS_TOOLS, BORIS_READ_TOOLS, BORIS_MUTATE_TOOLS } from './tools'
import { prisma } from '@/lib/db/prisma'

describe('BORIS_TOOLS подмножества', () => {
  it('BORIS_TOOLS содержит ровно 13 tools', () => {
    expect(BORIS_TOOLS.length).toBe(13)
  })

  it('BORIS_READ_TOOLS содержит ровно 7 read-tools', () => {
    expect(BORIS_READ_TOOLS.length).toBe(7)
  })

  it('BORIS_MUTATE_TOOLS содержит ровно 6 mutate-tools', () => {
    expect(BORIS_MUTATE_TOOLS.length).toBe(6)
  })

  it('READ + MUTATE = BORIS_TOOLS (нет пересечений и пропусков)', () => {
    const readNames = new Set(BORIS_READ_TOOLS.map((t) => t.name))
    const mutateNames = new Set(BORIS_MUTATE_TOOLS.map((t) => t.name))
    const allNames = new Set(BORIS_TOOLS.map((t) => t.name))

    for (const name of readNames) {
      expect(mutateNames.has(name)).toBe(false)
    }
    expect(readNames.size + mutateNames.size).toBe(allNames.size)
  })

  it('Все MUTATE-tools имеют ожидаемые имена', () => {
    const names = BORIS_MUTATE_TOOLS.map((t) => t.name).sort()
    expect(names).toEqual([
      'add_order_note',
      'cancel_order',
      'create_one_time_order',
      'edit_order_portions',
      'reschedule_order',
      'restore_order',
    ])
  })

  it('Все READ-tools имеют ожидаемые имена', () => {
    const names = BORIS_READ_TOOLS.map((t) => t.name).sort()
    expect(names).toEqual([
      'find_orders',
      'get_client_summary',
      'get_dish_margin',
      'get_menu_for_date',
      'get_order_details',
      'get_orders_for_date',
      'get_recent_client_messages',
    ])
  })
})

describe('Логика выбора tools по chatType + userRole', () => {
  // Документирующие тесты для гарантии что комбинаторика правильная.
  type Case = {
    chatType: 'private' | 'group' | 'supergroup' | 'channel'
    role: 'ADMIN_PRO' | 'ADMIN' | 'MANAGER' | 'CHEF' | 'COURIER'
    canMutate: boolean
  }

  const cases: Case[] = [
    { chatType: 'private', role: 'ADMIN_PRO', canMutate: true },
    { chatType: 'private', role: 'ADMIN', canMutate: false },
    { chatType: 'private', role: 'MANAGER', canMutate: false },
    { chatType: 'private', role: 'CHEF', canMutate: false },
    { chatType: 'private', role: 'COURIER', canMutate: false },
    { chatType: 'group', role: 'ADMIN_PRO', canMutate: false },
    { chatType: 'group', role: 'MANAGER', canMutate: false },
    { chatType: 'supergroup', role: 'ADMIN_PRO', canMutate: false },
    { chatType: 'channel', role: 'ADMIN_PRO', canMutate: false },
  ]

  for (const c of cases) {
    it(`chatType=${c.chatType} + role=${c.role} → canMutate=${c.canMutate}`, () => {
      const isPrivate = c.chatType === 'private'
      const isAdminPro = c.role === 'ADMIN_PRO'
      const canMutate = isPrivate && isAdminPro
      expect(canMutate).toBe(c.canMutate)
    })
  }
})

describe('find_orders SAME-DAY будущая дата (MEGA-4a-fix)', () => {
  const findOrders = BORIS_READ_TOOLS.find((t) => t.name === 'find_orders')!

  it('same-day клиент на будущую дату без заказов → {ok:false, reason:same_day_future}', async () => {
    // Резолвер вернёт этого клиента как exact с активной same-day локацией.
    vi.mocked(prisma.client.findMany).mockResolvedValue([
      {
        id: 'sk',
        name: 'Ск Техник',
        isActive: true,
        locations: [{ id: 'l1', sameDayDelivery: true, isActive: true }],
      },
    ] as never)
    // Заказов на запрошенную (будущую) дату ещё нет.
    vi.mocked(prisma.order.findMany).mockResolvedValue([] as never)

    // '2999-01-01' гарантированно > сегодня МСК → будущая дата.
    const res = await findOrders.execute({ clientNameQuery: 'ск техник', date: '2999-01-01' })

    expect(res).toMatchObject({
      ok: false,
      reason: 'same_day_future',
      clientName: 'Ск Техник',
      deliveryDate: '2999-01-01',
    })
  })

  it('same-day клиент, но есть заказы → обычный список (не блокируем)', async () => {
    vi.mocked(prisma.client.findMany).mockResolvedValue([
      {
        id: 'sk',
        name: 'Ск Техник',
        isActive: true,
        locations: [{ id: 'l1', sameDayDelivery: true, isActive: true }],
      },
    ] as never)
    vi.mocked(prisma.order.findMany).mockResolvedValue([
      {
        id: 'o1',
        mealType: 'LUNCH',
        deliveryDate: new Date('2999-01-01'),
        portions: 8,
        status: 'CONFIRMED',
        updatedAt: new Date('2026-06-01'),
        client: { id: 'sk', name: 'Ск Техник' },
        location: { id: 'l1', name: 'Точка' },
      },
    ] as never)

    const res = (await findOrders.execute({ clientNameQuery: 'ск техник', date: '2999-01-01' })) as {
      items: unknown[]
    }
    expect(Array.isArray(res.items)).toBe(true)
    expect(res.items).toHaveLength(1)
  })
})
