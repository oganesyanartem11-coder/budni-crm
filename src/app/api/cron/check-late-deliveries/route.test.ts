import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockActivityCreate,
  mockFindMany,
  mockNotifyGroup,
  mockUpdateMany,
} = vi.hoisted(() => ({
  mockActivityCreate: vi.fn(),
  mockFindMany: vi.fn(),
  mockNotifyGroup: vi.fn(),
  mockUpdateMany: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    courierRouteStop: {
      findMany: mockFindMany,
      updateMany: mockUpdateMany,
    },
    activityLog: { create: mockActivityCreate },
  },
}))
vi.mock('@/lib/telegram/notify', () => ({
  notifyGroup: mockNotifyGroup,
  escapeHtml: (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;'),
}))
vi.mock('@/lib/telegram/env', () => ({
  getTelegramEnv: () => ({ appBaseUrl: 'https://crm.test' }),
}))
vi.mock('@/lib/cron/with-heartbeat', () => ({
  withCronHeartbeat: (_name: string, cronHandler: unknown) => cronHandler,
}))

import {
  buildLateDeliveryAlertText,
  handler,
  LATE_ALERT_CLAIM_STALE_MINUTES,
} from './route'

const NOW = new Date('2026-08-21T07:20:01.000Z')
const REQUEST = new Request('http://local/api/cron/check-late-deliveries')

function candidate(over: Record<string, unknown> = {}) {
  return {
    id: 'stop-1',
    deliveryDate: new Date('2026-08-21T00:00:00.000Z'),
    assignmentMode: 'IN_HOUSE' as const,
    clientNameSnapshot: 'Клиент & партнёры',
    locationNameSnapshot: 'Точка <А>',
    deliveryWindowFromSnapshot: '09:30',
    deliveryWindowToSnapshot: '10:00',
    routeDay: { courierNameSnapshot: 'Курьер > Иван' },
    ...over,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.clearAllMocks()
  delete process.env.DELIVERY_LATE_ALERTS_ENABLED
  mockFindMany.mockResolvedValue([candidate()])
  mockUpdateMany.mockResolvedValue({ count: 1 })
  mockNotifyGroup.mockResolvedValue({ ok: true })
  mockActivityCreate.mockResolvedValue({ id: 'log-1' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('check-late-deliveries CourierRouteStop cron', () => {
  it('claims one eligible open stop, sends deterministic HTML and marks it sent', async () => {
    const response = await handler(REQUEST)
    const body = await response.json()

    expect(body).toEqual({ ok: true, sent: 1, errors: [] })
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        deliveryDate: new Date('2026-08-21T00:00:00.000Z'),
        deliveredAt: null,
        cancelledAt: null,
        lateAlertSentAt: null,
        deliveryWindowToSnapshot: { not: null },
      }),
    }))
    expect(mockUpdateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        id: 'stop-1',
        deliveredAt: null,
        cancelledAt: null,
        lateAlertSentAt: null,
      }),
      data: { lateAlertClaimedAt: NOW },
    }))
    expect(mockNotifyGroup).toHaveBeenCalledTimes(1)
    expect(mockNotifyGroup).toHaveBeenCalledWith(expect.stringContaining('https://crm.test/delivery/control'), { parseMode: 'HTML' })
    expect(mockUpdateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: { lateAlertClaimedAt: null, lateAlertSentAt: NOW },
    }))
  })

  it('uses a conditional stale-claim recovery so concurrent/repeated runs send once', async () => {
    expect(LATE_ALERT_CLAIM_STALE_MINUTES).toBe(15)
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })

    await handler(REQUEST)
    await handler(REQUEST)

    expect(mockNotifyGroup).toHaveBeenCalledTimes(1)
    expect(mockFindMany.mock.calls[0][0].where.OR).toEqual([
      { lateAlertClaimedAt: null },
      { lateAlertClaimedAt: { lt: new Date('2026-08-21T07:05:01.000Z') } },
    ])
  })

  it('escapes HTML and includes courier, client, location, window, delay and control link', () => {
    const text = buildLateDeliveryAlertText(
      candidate(),
      NOW,
      'https://crm.test/delivery/control?from=a&to=b',
    )

    expect(text).toContain('Курьер &gt; Иван')
    expect(text).toContain('Клиент &amp; партнёры')
    expect(text).toContain('Точка &lt;А&gt;')
    expect(text).toContain('09:30 — 10:00')
    expect(text).toContain('20 мин')
    expect(text).toContain('https://crm.test/delivery/control?from=a&amp;to=b')
  })

  it('releases the claim, logs the error and returns failure so a retry remains possible', async () => {
    mockNotifyGroup.mockResolvedValueOnce({ ok: false, error: 'telegram_down' })

    const failed = await handler(REQUEST)
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({
      ok: false,
      sent: 0,
      errors: [{ stopId: 'stop-1', reason: 'telegram_down' }],
    })
    expect(mockUpdateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: { lateAlertClaimedAt: null },
    }))
    expect(mockActivityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'LATE_DELIVERY_ALERTS_SENT',
        payload: expect.objectContaining({ errors: 1 }),
      }),
    }))

    mockNotifyGroup.mockResolvedValueOnce({ ok: true })
    const retried = await handler(REQUEST)
    expect(retried.status).toBe(200)
    expect(mockNotifyGroup).toHaveBeenCalledTimes(2)
  })
})
