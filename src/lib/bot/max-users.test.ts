import { describe, it, expect, beforeEach, vi } from 'vitest'

// Моки prisma.clientMaxUser.* + client.findUnique + $transaction.
const mockCmuFindFirst = vi.hoisted(() => vi.fn())
const mockCmuFindUnique = vi.hoisted(() => vi.fn())
const mockCmuUpdate = vi.hoisted(() => vi.fn())
const mockCmuUpdateMany = vi.hoisted(() => vi.fn())
const mockClientFindUnique = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    clientMaxUser: {
      findFirst: mockCmuFindFirst,
      findUnique: mockCmuFindUnique,
      update: mockCmuUpdate,
      updateMany: mockCmuUpdateMany,
    },
    client: { findUnique: mockClientFindUnique },
    $transaction: mockTransaction,
  },
}))

import {
  getActiveMaxChatIdForClient,
  resolveClientByChatId,
  promoteToActiveByChatId,
} from './max-users'

beforeEach(() => {
  vi.clearAllMocks()
  mockCmuUpdate.mockResolvedValue({})
  mockCmuUpdateMany.mockResolvedValue({ count: 1 })
  mockTransaction.mockResolvedValue([])
})

describe('getActiveMaxChatIdForClient', () => {
  it('возвращает chatId активного пользователя', async () => {
    mockCmuFindFirst.mockResolvedValue({ chatId: '12345' })
    expect(await getActiveMaxChatIdForClient('c1')).toBe('12345')
    expect(mockCmuFindFirst).toHaveBeenCalledWith({
      where: { clientId: 'c1', isActive: true },
      select: { chatId: true },
    })
  })

  it('null если активного нет', async () => {
    mockCmuFindFirst.mockResolvedValue(null)
    expect(await getActiveMaxChatIdForClient('c1')).toBeNull()
  })
})

describe('resolveClientByChatId', () => {
  it('находит клиента по chatId и обновляет lastSeenAt', async () => {
    mockCmuFindUnique.mockResolvedValue({ id: 'cmxu_1', clientId: 'c1' })
    mockClientFindUnique.mockResolvedValue({ id: 'c1', name: 'Клиент', locations: [] })

    const client = await resolveClientByChatId('12345')
    expect(client).toEqual({ id: 'c1', name: 'Клиент', locations: [] })
    // lastSeenAt — fire-and-forget update по найденной привязке.
    expect(mockCmuUpdate).toHaveBeenCalledWith({
      where: { id: 'cmxu_1' },
      data: { lastSeenAt: expect.any(Date) },
    })
  })

  it('null если chatId не привязан', async () => {
    mockCmuFindUnique.mockResolvedValue(null)
    expect(await resolveClientByChatId('999')).toBeNull()
    expect(mockClientFindUnique).not.toHaveBeenCalled()
  })
})

describe('promoteToActiveByChatId', () => {
  it('переключает active с другого пользователя на этого (транзакция)', async () => {
    mockCmuFindUnique.mockResolvedValue({ id: 'cmxu_2', clientId: 'c1', isActive: false })
    await promoteToActiveByChatId('67890')
    // Транзакция: гасим всех активных у клиента → поднимаем нужного.
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(mockCmuUpdateMany).toHaveBeenCalledWith({
      where: { clientId: 'c1', isActive: true },
      data: { isActive: false },
    })
    expect(mockCmuUpdate).toHaveBeenCalledWith({
      where: { id: 'cmxu_2' },
      data: { isActive: true },
    })
  })

  it('идемпотентно: уже активный → транзакция не вызывается', async () => {
    mockCmuFindUnique.mockResolvedValue({ id: 'cmxu_3', clientId: 'c1', isActive: true })
    await promoteToActiveByChatId('67890')
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it('chatId не найден → no-op', async () => {
    mockCmuFindUnique.mockResolvedValue(null)
    await promoteToActiveByChatId('999')
    expect(mockTransaction).not.toHaveBeenCalled()
  })
})
