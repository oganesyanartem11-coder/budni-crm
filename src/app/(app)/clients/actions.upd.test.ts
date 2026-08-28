import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPrisma, mockRequireRole, mockRevalidatePath } = vi.hoisted(() => ({
  mockPrisma: {
    client: {
      create: vi.fn(),
    },
    activityLog: {
      create: vi.fn(),
    },
  },
  mockRequireRole: vi.fn(),
  mockRevalidatePath: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }))

import { createClient } from './actions'

const ADMIN = { id: 'u_admin', role: 'ADMIN' as const }

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireRole.mockResolvedValue(ADMIN)
  mockPrisma.client.create.mockResolvedValue({ id: 'client_1', name: 'Покупатель без ИНН' })
  mockPrisma.activityLog.create.mockResolvedValue({})
})

describe('createClient legal entity defaults', () => {
  it('persists defaultOurLegalEntityId when the buyer INN is empty', async () => {
    const result = await createClient({
      name: 'Покупатель без ИНН',
      defaultOurLegalEntityId: 'our_legal_entity_1',
    })

    expect(result).toEqual({ ok: true, data: { id: 'client_1' } })
    expect(mockPrisma.client.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inn: null,
        defaultOurLegalEntityId: 'our_legal_entity_1',
      }),
    })
    expect(mockRevalidatePath).toHaveBeenCalledWith('/clients')
  })

  it.each([
    ['legalName', 'ООО «Частичные реквизиты»'],
    ['kpp', '123456789'],
    ['ogrn', '1234567890123'],
    ['legalAddress', 'г. Москва'],
  ] as const)('still rejects %s without an INN', async (field, value) => {
    const result = await createClient({
      name: 'Покупатель без ИНН',
      [field]: value,
    })

    expect(result).toEqual({
      ok: false,
      error: 'Если заполнены юр.поля — обязательно укажите ИНН (или очистите остальные поля)',
    })
    expect(mockPrisma.client.create).not.toHaveBeenCalled()
  })
})
