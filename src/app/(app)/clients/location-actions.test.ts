import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Boris wave 4 — юнит-тесты deliveryFee на createLocation/updateLocation.
 * Мокаем prisma.clientLocation (create/update), requireRole, revalidatePath.
 * Проверяем что:
 *  - число из zod доходит до prisma.data.deliveryFee;
 *  - null/отсутствие → deliveryFee: null (бесплатная доставка);
 *  - отрицательное значение отклоняется zod.
 */

const { mockPrisma, mockRequireRole } = vi.hoisted(() => ({
  mockPrisma: {
    clientLocation: {
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  mockRequireRole: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { createLocation, updateLocation } from './actions'

const ADMIN = { id: 'u_admin', role: 'ADMIN' as const }

const baseForm = {
  name: 'Стройка №1',
  address: 'ул. Ленина, 1',
  packaging: 'INDIVIDUAL' as const,
  tags: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireRole.mockResolvedValue(ADMIN)
})

describe('createLocation deliveryFee', () => {
  it('прокидывает числовое значение deliveryFee в prisma.data', async () => {
    mockPrisma.clientLocation.create.mockResolvedValue({ id: 'loc_1' })

    const res = await createLocation('c1', { ...baseForm, deliveryFee: 500 })

    expect(res.ok).toBe(true)
    const data = mockPrisma.clientLocation.create.mock.calls[0][0].data
    expect(data.deliveryFee).toBe(500)
  })

  it('deliveryFee=null → null (бесплатная доставка)', async () => {
    mockPrisma.clientLocation.create.mockResolvedValue({ id: 'loc_2' })

    const res = await createLocation('c1', { ...baseForm, deliveryFee: null })

    expect(res.ok).toBe(true)
    const data = mockPrisma.clientLocation.create.mock.calls[0][0].data
    expect(data.deliveryFee).toBeNull()
  })

  it('без deliveryFee (поле опущено) → null', async () => {
    mockPrisma.clientLocation.create.mockResolvedValue({ id: 'loc_3' })

    const res = await createLocation('c1', { ...baseForm })

    expect(res.ok).toBe(true)
    const data = mockPrisma.clientLocation.create.mock.calls[0][0].data
    expect(data.deliveryFee).toBeNull()
  })

  it('отрицательный deliveryFee отклоняется zod, prisma не вызывается', async () => {
    const res = await createLocation('c1', { ...baseForm, deliveryFee: -10 })

    expect(res.ok).toBe(false)
    expect(mockPrisma.clientLocation.create).not.toHaveBeenCalled()
  })
})

describe('updateLocation deliveryFee', () => {
  it('прокидывает deliveryFee в prisma.update.data', async () => {
    mockPrisma.clientLocation.update.mockResolvedValue({ id: 'loc_1', clientId: 'c1' })

    const res = await updateLocation('loc_1', { ...baseForm, deliveryFee: 750.5 })

    expect(res.ok).toBe(true)
    const data = mockPrisma.clientLocation.update.mock.calls[0][0].data
    expect(data.deliveryFee).toBe(750.5)
  })

  it('обнуление deliveryFee → null', async () => {
    mockPrisma.clientLocation.update.mockResolvedValue({ id: 'loc_1', clientId: 'c1' })

    const res = await updateLocation('loc_1', { ...baseForm, deliveryFee: null })

    expect(res.ok).toBe(true)
    const data = mockPrisma.clientLocation.update.mock.calls[0][0].data
    expect(data.deliveryFee).toBeNull()
  })
})
