import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindUnique, mockUpsert } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpsert: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    borisDirectState: {
      findUnique: mockFindUnique,
      upsert: mockUpsert,
    },
  },
}))

import { getDirectRoleState, setDirectMode, setDirectFrozen } from './state'

describe('getDirectRoleState — безопасные дефолты', () => {
  beforeEach(() => {
    mockFindUnique.mockReset()
    mockUpsert.mockReset()
  })

  it('нет строки в БД → OBSERVE, не frozen, гейт стоит (сид не нужен)', async () => {
    mockFindUnique.mockResolvedValue(null)
    const state = await getDirectRoleState()
    expect(state).toEqual({ mode: 'OBSERVE', frozen: false, autoNegativesEnabled: false })
  })

  it('строка есть → читаем как есть', async () => {
    mockFindUnique.mockResolvedValue({
      key: 'main',
      mode: 'LIVE',
      frozen: true,
      autoNegativesEnabled: true,
    })
    const state = await getDirectRoleState()
    expect(state).toEqual({ mode: 'LIVE', frozen: true, autoNegativesEnabled: true })
  })

  it('setDirectMode/setDirectFrozen — upsert по key=main', async () => {
    mockUpsert.mockResolvedValue({})
    await setDirectMode('LIVE')
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'main' } })
    )
    await setDirectFrozen(true)
    expect(mockUpsert.mock.calls[1][0].update.frozen).toBe(true)
  })
})
