import { describe, it, expect, beforeEach, vi } from 'vitest'

/** Sprint 8.0: дубли заявок по телефону — best effort, никогда не бросают. */

const { mockPrisma, mockTrackError } = vi.hoisted(() => ({
  mockPrisma: {
    landingLead: { findFirst: vi.fn(), update: vi.fn() },
    salesActivity: { create: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
  mockTrackError: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/errors/tracker', () => ({ trackError: mockTrackError }))

import { findActiveLeadByPhone, linkDuplicateLeads, recordRepeatSubmission } from './duplicates'

const NOW = new Date('2026-09-24T09:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops))
  mockPrisma.landingLead.update.mockResolvedValue({ id: 'x' })
  mockPrisma.salesActivity.create.mockResolvedValue({ id: 'a' })
  mockTrackError.mockResolvedValue(undefined)
})

describe('findActiveLeadByPhone', () => {
  it('активная неархивная за 30 дней, кроме excludeId', async () => {
    mockPrisma.landingLead.findFirst.mockResolvedValue({ id: 'old' })
    expect(await findActiveLeadByPhone('79991234567', { excludeId: 'new', now: NOW })).toEqual({ id: 'old' })
    const where = mockPrisma.landingLead.findFirst.mock.calls[0][0].where
    expect(where).toMatchObject({ phoneDigits: '79991234567', archivedAt: null, id: { not: 'new' } })
    expect(where.pipelineStatus.in).not.toContain('WON')
    expect(where.createdAt.gte).toEqual(new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000))
  })

  it('ошибка чтения → null, не бросает', async () => {
    mockPrisma.landingLead.findFirst.mockRejectedValue(new Error('db down'))
    expect(await findActiveLeadByPhone('79991234567')).toBeNull()
  })
})

describe('linkDuplicateLeads / recordRepeatSubmission', () => {
  it('пометки DUPLICATE на обеих карточках, старая поднимается', async () => {
    await linkDuplicateLeads('new', 'old', NOW)
    const acts = mockPrisma.salesActivity.create.mock.calls.map((c) => c[0].data)
    expect(acts).toEqual([
      expect.objectContaining({ leadId: 'new', kind: 'DUPLICATE', meta: { duplicateOfLeadId: 'old' } }),
      expect.objectContaining({ leadId: 'old', kind: 'DUPLICATE', meta: { newLeadId: 'new' } }),
    ])
    expect(mockPrisma.landingLead.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'old' },
      data: { lastActivityAt: NOW },
    })
  })

  it('падение транзакции → не бросает', async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error('db down'))
    await expect(linkDuplicateLeads('new', 'old')).resolves.toBeUndefined()
    await expect(recordRepeatSubmission('old')).resolves.toBeUndefined()
    expect(mockTrackError).toHaveBeenCalledTimes(2)
  })

  it('повторная заявка → событие «Повторная заявка с сайта»', async () => {
    await recordRepeatSubmission('old', { source: 'chef' }, NOW)
    expect(mockPrisma.salesActivity.create.mock.calls[0][0].data).toEqual({
      leadId: 'old',
      kind: 'DUPLICATE',
      text: 'Повторная заявка с сайта',
      meta: { source: 'chef' },
    })
  })
})
