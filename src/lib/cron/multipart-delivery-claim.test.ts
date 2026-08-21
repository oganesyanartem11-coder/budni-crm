import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSetting } = vi.hoisted(() => ({
  mockSetting: {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: { setting: mockSetting } }))

import {
  acquireMultipartDeliveryClaim,
  completeMultipartDeliveryClaim,
  failMultipartDeliveryClaim,
  markMultipartDeliveryPartSent,
  resumeMultipartDeliveryClaim,
} from './multipart-delivery-claim'

const now = new Date('2026-08-11T15:10:00.000Z')
const messages = ['часть 1', 'часть 2']

beforeEach(() => {
  vi.clearAllMocks()
})

function uniqueConflict() {
  return Object.assign(new Error('unique'), { code: 'P2002' })
}

describe('multipart delivery claim', () => {
  it('atomically creates a unique sending lease before delivery', async () => {
    mockSetting.create.mockImplementation(async ({ data }) => data)

    const claim = await acquireMultipartDeliveryClaim('summary:2026-08-12', messages, now)

    expect(claim).toEqual(expect.objectContaining({
      status: 'acquired',
      messages,
      nextPartIndex: 0,
    }))
    expect(mockSetting.create).toHaveBeenCalledOnce()
    const value = JSON.parse(mockSetting.create.mock.calls[0][0].data.value)
    expect(value).toEqual(expect.objectContaining({
      state: 'SENDING',
      messages,
      nextPartIndex: 0,
      claimedAt: now.toISOString(),
    }))
  })

  it('makes a concurrent fresh runner skip before external side effects', async () => {
    const currentValue = JSON.stringify({
      version: 1,
      state: 'SENDING',
      token: 'other-runner',
      messages,
      nextPartIndex: 0,
      claimedAt: now.toISOString(),
    })
    mockSetting.create.mockRejectedValue(uniqueConflict())
    mockSetting.findUnique.mockResolvedValue({ value: currentValue })

    const claim = await acquireMultipartDeliveryClaim(
      'summary:2026-08-12',
      messages,
      new Date('2026-08-11T15:11:00.000Z'),
    )

    expect(claim).toEqual({ status: 'in_progress' })
    expect(mockSetting.updateMany).not.toHaveBeenCalled()
  })

  it('resumes a failed multipart from the first unsent stored part', async () => {
    const currentValue = JSON.stringify({
      version: 1,
      state: 'FAILED',
      token: 'failed-runner',
      messages,
      nextPartIndex: 1,
      claimedAt: now.toISOString(),
      lastError: 'telegram unavailable',
    })
    mockSetting.create.mockRejectedValue(uniqueConflict())
    mockSetting.findUnique.mockResolvedValue({ value: currentValue })
    mockSetting.updateMany.mockResolvedValue({ count: 1 })

    const claim = await acquireMultipartDeliveryClaim(
      'summary:2026-08-12',
      ['новый пересчитанный текст'],
      new Date('2026-08-11T15:12:00.000Z'),
    )

    expect(claim).toEqual(expect.objectContaining({
      status: 'acquired',
      messages,
      nextPartIndex: 1,
    }))
  })

  it('resumes an existing failed claim without a newly calculated message list', async () => {
    const currentValue = JSON.stringify({
      version: 1,
      state: 'FAILED',
      token: 'failed-runner',
      messages,
      nextPartIndex: 1,
      claimedAt: now.toISOString(),
      lastError: 'telegram unavailable',
    })
    mockSetting.findUnique.mockResolvedValue({ value: currentValue })
    mockSetting.updateMany.mockResolvedValue({ count: 1 })

    const claim = await resumeMultipartDeliveryClaim(
      'summary:2026-08-12',
      new Date('2026-08-11T15:12:00.000Z'),
    )

    expect(claim).toEqual(expect.objectContaining({
      status: 'acquired',
      messages,
      nextPartIndex: 1,
    }))
    expect(mockSetting.create).not.toHaveBeenCalled()
  })

  it('reports no claim when there is nothing durable to resume', async () => {
    mockSetting.findUnique.mockResolvedValue(null)

    await expect(resumeMultipartDeliveryClaim('summary:2026-08-12', now))
      .resolves.toEqual({ status: 'no_claim' })
  })

  it('persists each sent part, then marks the claim sent with compare-and-swap', async () => {
    mockSetting.create.mockImplementation(async ({ data }) => data)
    mockSetting.updateMany.mockResolvedValue({ count: 1 })
    const acquired = await acquireMultipartDeliveryClaim(
      'summary:2026-08-12',
      messages,
      now,
    )
    if (acquired.status !== 'acquired') throw new Error('expected acquired claim')

    const afterFirst = await markMultipartDeliveryPartSent(acquired, 0)
    expect(afterFirst.nextPartIndex).toBe(1)
    const afterSecond = await markMultipartDeliveryPartSent(afterFirst, 1)
    await completeMultipartDeliveryClaim(afterSecond)

    const writes = mockSetting.updateMany.mock.calls.map((call) =>
      JSON.parse(call[0].data.value),
    )
    expect(writes[0]).toEqual(expect.objectContaining({
      state: 'SENDING',
      nextPartIndex: 1,
    }))
    expect(writes[1]).toEqual(expect.objectContaining({
      state: 'SENDING',
      nextPartIndex: 2,
    }))
    expect(writes[2]).toEqual(expect.objectContaining({
      state: 'SENT',
      nextPartIndex: 2,
      messages: [],
    }))
  })

  it('refuses to mark SENT while a part is still unsent', async () => {
    mockSetting.create.mockImplementation(async ({ data }) => data)
    const acquired = await acquireMultipartDeliveryClaim(
      'summary:2026-08-12',
      messages,
      now,
    )
    if (acquired.status !== 'acquired') throw new Error('expected acquired claim')

    await expect(completeMultipartDeliveryClaim(acquired))
      .rejects.toThrow('unsent parts')
    expect(mockSetting.updateMany).not.toHaveBeenCalled()
  })

  it('recognizes its persisted SENT representation on the next acquisition', async () => {
    const sentValue = JSON.stringify({
      version: 1,
      state: 'SENT',
      token: 'completed-runner',
      messages: [],
      nextPartIndex: 2,
      claimedAt: now.toISOString(),
    })
    mockSetting.create.mockRejectedValue(uniqueConflict())
    mockSetting.findUnique.mockResolvedValue({ value: sentValue })
    mockSetting.updateMany.mockResolvedValue({ count: 1 })

    const result = await acquireMultipartDeliveryClaim(
      'summary:2026-08-12',
      messages,
      new Date('2026-08-11T15:20:00.000Z'),
    )

    expect(result).toEqual({ status: 'already_sent' })
    expect(mockSetting.updateMany).not.toHaveBeenCalled()
  })

  it('keeps sent-part progress when delivery fails', async () => {
    mockSetting.create.mockImplementation(async ({ data }) => data)
    mockSetting.updateMany.mockResolvedValue({ count: 1 })
    const acquired = await acquireMultipartDeliveryClaim(
      'summary:2026-08-12',
      messages,
      now,
    )
    if (acquired.status !== 'acquired') throw new Error('expected acquired claim')
    const afterFirst = await markMultipartDeliveryPartSent(acquired, 0)

    await failMultipartDeliveryClaim(afterFirst, 'telegram unavailable')

    const failed = JSON.parse(mockSetting.updateMany.mock.calls[1][0].data.value)
    expect(failed).toEqual(expect.objectContaining({
      state: 'FAILED',
      nextPartIndex: 1,
      messages,
      lastError: 'telegram unavailable',
    }))
  })
})
