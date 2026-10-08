import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrisma, mockSend, mockChatId } = vi.hoisted(() => ({
  mockPrisma: {
    botConversation: { findMany: vi.fn(), update: vi.fn() },
    botMessage: { create: vi.fn() },
    client: { findMany: vi.fn() },
    order: { findMany: vi.fn() },
    clientMealConfig: { findMany: vi.fn() },
    activityLog: { findFirst: vi.fn(), create: vi.fn() },
  },
  mockSend: vi.fn(),
  mockChatId: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/max/send-message', () => ({ sendBotMessage: mockSend }))
vi.mock('@/lib/bot/max-users', () => ({ getActiveMaxChatIdForClient: mockChatId }))
vi.mock('@/lib/db/queries/bot', () => ({ getNextActiveDayForClient: vi.fn() }))
vi.mock('@/lib/cron/with-heartbeat', () => ({ withCronHeartbeat: (_: string, h: unknown) => h }))

import { handler } from './route'
import { SAME_DAY_DYNAMIC_LOCATION } from '@/lib/bot/daily-questions-core'

const TOMORROW = new Date('2026-06-09T00:00:00.000Z')
const REQ = new Request('http://x/api/cron/cutoff-notice')

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.activityLog.findFirst.mockResolvedValue(null)
  mockPrisma.activityLog.create.mockResolvedValue({})
  mockPrisma.botConversation.findMany.mockResolvedValue([
    { id: 'cv1', clientId: 'c1', deliveryDate: TOMORROW, client: { id: 'c1', name: 'Кафе' } },
  ])
  mockPrisma.client.findMany.mockResolvedValue([])
  mockPrisma.clientMealConfig.findMany.mockResolvedValue([
    { locationId: 'l1', mealType: 'LUNCH', scheduleType: 'DAILY', scheduleData: null, validFrom: null, validTo: null },
  ])
  mockPrisma.order.findMany.mockResolvedValue([])
  mockChatId.mockResolvedValue('chat1')
})

describe('cutoff-notice', () => {
  it('молчащий клиент без числа → «приём закрыт» + EXPIRED', async () => {
    const body = await (await handler(REQ)).json()
    expect(body.sent_notices).toBe(1)
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockPrisma.botConversation.update).toHaveBeenCalledWith({
      where: { id: 'cv1' },
      data: { status: 'EXPIRED' },
    })
  })

  it('число уже поставил менеджер/Борис → «приём закрыт» не шлём, conv не экспайрим', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      { locationId: 'l1', mealType: 'LUNCH', portions: 7, status: 'CONFIRMED' },
    ])
    const body = await (await handler(REQ)).json()
    expect(body.sent_notices).toBe(0)
    expect(body.skipped_answered).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockPrisma.botConversation.update).not.toHaveBeenCalled()
  })

  it('same-day исключение — только активная same-day точка с DYNAMIC', async () => {
    await handler(REQ)
    const where = mockPrisma.client.findMany.mock.calls[0][0].where
    expect(where.locations).toEqual({ some: SAME_DAY_DYNAMIC_LOCATION })
  })
})
