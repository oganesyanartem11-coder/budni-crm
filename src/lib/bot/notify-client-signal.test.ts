import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Cooldown алёртов о клиенте: глушит только повторы одного сигнала, а не
 * новую работу (новый InboxItem / HIGH). POST_CUTOFF — без хардкода 16:00.
 */

const { mockPrisma, mockNotify } = vi.hoisted(() => ({
  mockPrisma: {
    client: { findUnique: vi.fn() },
    clientAlertLog: { findMany: vi.fn(), create: vi.fn() },
  },
  mockNotify: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/telegram/notify', async () => {
  const actual = await vi.importActual<typeof import('@/lib/telegram/notify')>('@/lib/telegram/notify')
  return { ...actual, notifyAlertRecipients: mockNotify }
})

vi.mock('@/lib/telegram/buttons', () => ({ inboxButton: vi.fn(() => ({ inline_keyboard: [] })) }))

import { cooldownBreakthrough, notifyClientSignal } from './notify-client-signal'

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.client.findUnique.mockResolvedValue({ id: 'c1', name: 'ХАЛВА' })
  mockPrisma.clientAlertLog.findMany.mockResolvedValue([])
  mockPrisma.clientAlertLog.create.mockResolvedValue({})
  mockNotify.mockResolvedValue({ sentTo: 1, skippedNoTelegram: 0, failed: 0 })
})

describe('cooldownBreakthrough', () => {
  const recentInbox = [{ tone: null, inboxItemId: 'inbox_A', priority: 'NORMAL' }]

  it('нет недавних алёртов → шлём', () => {
    expect(cooldownBreakthrough([], { inboxItemId: null, tone: 'rude' })).toBe('no_recent')
  })

  it('новый InboxItem пробивает cooldown', () => {
    expect(cooldownBreakthrough(recentInbox, { inboxItemId: 'inbox_B', priority: 'NORMAL' })).toBe(
      'new_inbox_item',
    )
  })

  it('повтор того же InboxItem — глушим', () => {
    expect(cooldownBreakthrough(recentInbox, { inboxItemId: 'inbox_A', priority: 'NORMAL' })).toBeNull()
  })

  it('InboxItem, уже алёртнутый раньше в окне (не последним), — глушим', () => {
    const recent = [
      { tone: null, inboxItemId: 'inbox_B', priority: 'NORMAL' },
      { tone: null, inboxItemId: 'inbox_A', priority: 'NORMAL' },
    ]
    expect(cooldownBreakthrough(recent, { inboxItemId: 'inbox_A' })).toBeNull()
  })

  it('HIGH без InboxItem пробивает, HIGH по тому же InboxItem — нет', () => {
    expect(cooldownBreakthrough(recentInbox, { inboxItemId: null, priority: 'HIGH' })).toBe('high_priority')
    expect(cooldownBreakthrough(recentInbox, { inboxItemId: 'inbox_A', priority: 'HIGH' })).toBeNull()
  })

  it('чистый tone-повтор глушится, rude→urgent прорывается, urgent→urgent нет', () => {
    const rude = [{ tone: 'rude', inboxItemId: null, priority: null }]
    const urgent = [{ tone: 'urgent', inboxItemId: null, priority: null }]
    expect(cooldownBreakthrough(rude, { inboxItemId: null, tone: 'rude' })).toBeNull()
    expect(cooldownBreakthrough(rude, { inboxItemId: null, tone: 'urgent' })).toBe('escalation')
    expect(cooldownBreakthrough(urgent, { inboxItemId: null, tone: 'urgent' })).toBeNull()
  })
})

describe('notifyClientSignal', () => {
  it('второй InboxItem того же клиента в окне 2 мин — пуш уходит', async () => {
    mockPrisma.clientAlertLog.findMany.mockResolvedValue([
      { tone: null, inboxItemId: 'inbox_A', priority: 'NORMAL' },
    ])
    await notifyClientSignal({
      clientId: 'c1',
      messageText: 'и ещё на пятницу 20',
      inboxItemId: 'inbox_B',
      reason: 'NON_NUMERIC',
      priority: 'NORMAL',
    })
    expect(mockNotify).toHaveBeenCalledTimes(1)
    expect(mockPrisma.clientAlertLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ inboxItemId: 'inbox_B' }),
    })
  })

  it('повтор тона без нового InboxItem — тишина', async () => {
    mockPrisma.clientAlertLog.findMany.mockResolvedValue([{ tone: 'rude', inboxItemId: null, priority: null }])
    await notifyClientSignal({ clientId: 'c1', messageText: 'да сколько можно', tone: 'rude' })
    expect(mockNotify).not.toHaveBeenCalled()
    expect(mockPrisma.clientAlertLog.create).not.toHaveBeenCalled()
  })

  it('POST_CUTOFF: реальный cut-off, если передан', async () => {
    await notifyClientSignal({
      clientId: 'c1',
      messageText: 'завтра 30',
      inboxItemId: 'inbox_A',
      reason: 'POST_CUTOFF',
      cutoffLabel: '15:00',
    })
    expect(mockNotify.mock.calls[0][0]).toContain('написал после 15:00:')
  })

  it('POST_CUTOFF без cut-off — нейтрально, без хардкода 16:00', async () => {
    await notifyClientSignal({
      clientId: 'c1',
      messageText: 'завтра 30',
      inboxItemId: 'inbox_A',
      reason: 'POST_CUTOFF',
    })
    const text = mockNotify.mock.calls[0][0] as string
    expect(text).toContain('написал после приёма заявок:')
    expect(text).not.toContain('16:00')
  })
})
