import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFindMany, mockUpdateMany, mockNotifyTaskDue, mockTrackError } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockNotifyTaskDue: vi.fn(),
  mockTrackError: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: { salesTask: { findMany: mockFindMany, updateMany: mockUpdateMany } },
}))
vi.mock('@/lib/sales/notify', () => ({ notifyTaskDue: mockNotifyTaskDue }))
vi.mock('@/lib/errors/tracker', () => ({ trackError: mockTrackError }))
vi.mock('@/lib/cron/with-heartbeat', () => ({
  withCronHeartbeat: (_name: string, cronHandler: unknown) => cronHandler,
}))

import { handler } from './route'

const NOW = new Date('2026-09-24T09:00:00.000Z')
const REQUEST = new Request('http://local/api/cron/sales-reminders')

function dueTask(id: string) {
  return {
    id,
    leadId: `lead_${id}`,
    type: 'CALL' as const,
    title: 'Связаться',
    note: null,
    dueAt: new Date('2026-09-24T08:50:00.000Z'),
    assigneeId: 'user_1',
    lead: { id: `lead_${id}`, company: null, name: 'Иван', phone: '+7 999' },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.clearAllMocks()
  mockFindMany.mockResolvedValue([dueTask('t1')])
  mockUpdateMany.mockResolvedValue({ count: 1 })
  mockNotifyTaskDue.mockResolvedValue({ delivered: true, skipped: false })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sales-reminders cron', () => {
  it('выбирает открытые задачи активных неархивных заявок с наступившим сроком', async () => {
    await handler(REQUEST)

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          doneAt: null,
          notifiedAt: null,
          dueAt: { lte: NOW },
          lead: {
            archivedAt: null,
            pipelineStatus: { in: ['NEW', 'IN_PROGRESS', 'PROPOSAL_SENT', 'TRIAL', 'CONTRACT'] },
          },
        },
        orderBy: { dueAt: 'asc' },
        take: 50,
      })
    )
  })

  it('клеймит notifiedAt до отправки и шлёт напоминание', async () => {
    const res = await handler(REQUEST)

    expect(await res.json()).toEqual({ ok: true, sent: 1, skipped: 0, failed: 0 })
    expect(mockUpdateMany).toHaveBeenCalledTimes(1)
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 't1', notifiedAt: null, doneAt: null },
      data: { notifiedAt: NOW },
    })
    const [task, lead, now] = mockNotifyTaskDue.mock.calls[0]
    expect(task.id).toBe('t1')
    expect(lead).toEqual({ id: 'lead_t1', company: null, name: 'Иван', phone: '+7 999' })
    expect(now).toEqual(NOW)
  })

  it('claim не прошёл (забрал другой инстанс) → не шлём', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })

    const res = await handler(REQUEST)

    expect(await res.json()).toEqual({ ok: true, sent: 0, skipped: 0, failed: 0 })
    expect(mockNotifyTaskDue).not.toHaveBeenCalled()
  })

  it('никому не доставлено → откат notifiedAt + warn в трекер', async () => {
    mockFindMany.mockResolvedValue([dueTask('t1'), dueTask('t2')])
    mockNotifyTaskDue
      .mockResolvedValueOnce({ delivered: false, skipped: true })
      .mockResolvedValueOnce({ delivered: false, skipped: false, error: 'admin_pro_failed: 1' })

    const res = await handler(REQUEST)

    expect(await res.json()).toEqual({ ok: true, sent: 0, skipped: 1, failed: 1 })
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 't1', notifiedAt: NOW },
      data: { notifiedAt: null },
    })
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 't2', notifiedAt: NOW },
      data: { notifiedAt: null },
    })
    expect(mockTrackError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        extra: { jobName: 'sales-reminders', taskId: 't1', reason: 'no_recipients' },
      })
    )
    expect(mockTrackError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        extra: { jobName: 'sales-reminders', taskId: 't2', reason: 'admin_pro_failed: 1' },
      })
    )
  })

  it('частичная доставка (ушло фолбэком) — claim остаётся', async () => {
    mockNotifyTaskDue.mockResolvedValue({ delivered: true, skipped: false, error: 'assignee: Forbidden' })

    const res = await handler(REQUEST)

    expect(await res.json()).toEqual({ ok: true, sent: 1, skipped: 0, failed: 0 })
    expect(mockUpdateMany).toHaveBeenCalledTimes(1)
    expect(mockTrackError).not.toHaveBeenCalled()
  })
})
