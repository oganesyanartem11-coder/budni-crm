import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * ШАГ 2 — дедуп ретраев приёмника заявок. Мокаем prisma; проверяем окно,
 * поиск свежего дубля, запись счётчика (мягкий сбой) и дневной счёт.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    landingLead: { findFirst: vi.fn() },
    activityLog: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn() },
  },
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

import {
  DEDUP_WINDOW_MS,
  HONEYPOT_ALERT_WINDOW_MS,
  findRecentDelivered,
  recordDelivered,
  findRecentDuplicate,
  recordDedupDrop,
  countDedupDropsToday,
  throttleHoneypotAlert,
} from './dedup'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DEDUP_WINDOW_MS', () => {
  it('окно = 5 минут', () => {
    expect(DEDUP_WINDOW_MS).toBe(5 * 60 * 1000)
  })
})

describe('findRecentDelivered — дедуп по факту ДОСТАВКИ, не по записи в БД', () => {
  it('была доставка по phone_digits в окне → {id}', async () => {
    mockPrisma.activityLog.findFirst.mockResolvedValue({ id: 'deliv-1' })
    const now = new Date('2026-07-06T10:00:00Z')
    const res = await findRecentDelivered('79995999967', now)
    expect(res).toEqual({ id: 'deliv-1' })
    const arg = mockPrisma.activityLog.findFirst.mock.calls[0][0]
    expect(arg.where.action).toBe('LEAD_INTAKE_DELIVERED')
    expect(arg.where.entityId).toBe('79995999967')
    expect((arg.where.createdAt.gte as Date).getTime()).toBe(now.getTime() - DEDUP_WINDOW_MS)
  })

  it('доставки не было → null; ошибка → null (доставляем при сомнении)', async () => {
    mockPrisma.activityLog.findFirst.mockResolvedValue(null)
    expect(await findRecentDelivered('7999')).toBeNull()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockPrisma.activityLog.findFirst.mockRejectedValue(new Error('db'))
    expect(await findRecentDelivered('7999')).toBeNull()
    errSpy.mockRestore()
  })
})

describe('recordDelivered', () => {
  it('пишет пометку LEAD_INTAKE_DELIVERED с телефоном в entityId', async () => {
    mockPrisma.activityLog.create.mockResolvedValue({ id: 'd1' })
    await recordDelivered('79995999967')
    expect(mockPrisma.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'LEAD_INTAKE_DELIVERED',
        entityType: 'LeadDelivered',
        entityId: '79995999967',
      }),
    })
  })

  it('ошибка записи не кидает', async () => {
    mockPrisma.activityLog.create.mockRejectedValue(new Error('db'))
    await expect(recordDelivered('7999')).resolves.toBeUndefined()
  })
})

describe('throttleHoneypotAlert — не чаще 1/час', () => {
  it('окно троттла = 1 час', () => {
    expect(HONEYPOT_ALERT_WINDOW_MS).toBe(60 * 60 * 1000)
  })

  it('не было алёрта за час → true, ставит марку', async () => {
    mockPrisma.activityLog.findFirst.mockResolvedValue(null)
    mockPrisma.activityLog.create.mockResolvedValue({ id: 'h1' })
    expect(await throttleHoneypotAlert(new Date('2026-07-06T10:00:00Z'))).toBe(true)
    expect(mockPrisma.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'LEAD_HONEYPOT_ALERT' }),
    })
  })

  it('был алёрт за час → false, марку НЕ ставит (не спамим)', async () => {
    mockPrisma.activityLog.findFirst.mockResolvedValue({ id: 'recent' })
    expect(await throttleHoneypotAlert()).toBe(false)
    expect(mockPrisma.activityLog.create).not.toHaveBeenCalled()
  })

  it('ошибка → false (молчим, не роняем)', async () => {
    mockPrisma.activityLog.findFirst.mockRejectedValue(new Error('db'))
    expect(await throttleHoneypotAlert()).toBe(false)
  })
})

describe('findRecentDuplicate', () => {
  it('нашёл свежую запись с тем же phone_digits → возвращает {id}', async () => {
    mockPrisma.landingLead.findFirst.mockResolvedValue({ id: 'prev-1' })
    const now = new Date('2026-07-06T10:00:00Z')
    const res = await findRecentDuplicate('79995999967', now)
    expect(res).toEqual({ id: 'prev-1' })
    const arg = mockPrisma.landingLead.findFirst.mock.calls[0][0]
    expect(arg.where.phoneDigits).toBe('79995999967')
    // окно: createdAt >= now - 5 мин
    expect((arg.where.createdAt.gte as Date).getTime()).toBe(now.getTime() - DEDUP_WINDOW_MS)
    expect(arg.select).toEqual({ id: true })
  })

  it('нет свежей записи → null', async () => {
    mockPrisma.landingLead.findFirst.mockResolvedValue(null)
    expect(await findRecentDuplicate('79995999967')).toBeNull()
  })

  it('ошибка запроса → null (при сомнении доставляем, не глушим)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockPrisma.landingLead.findFirst.mockRejectedValue(new Error('db down'))
    expect(await findRecentDuplicate('79995999967')).toBeNull()
    errSpy.mockRestore()
  })
})

describe('recordDedupDrop', () => {
  it('пишет счётчик в ActivityLog с action LEAD_INTAKE_DEDUPED', async () => {
    mockPrisma.activityLog.create.mockResolvedValue({ id: 'a1' })
    await recordDedupDrop('prev-1', 'quiz-block-3')
    expect(mockPrisma.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'LEAD_INTAKE_DEDUPED',
        entityType: 'LandingLead',
        entityId: 'prev-1',
        payload: { source: 'quiz-block-3' },
      }),
    })
  })

  it('ошибка записи НЕ пробрасывается (счётчик не роняет приём)', async () => {
    mockPrisma.activityLog.create.mockRejectedValue(new Error('db down'))
    await expect(recordDedupDrop('prev-1', null)).resolves.toBeUndefined()
  })
})

describe('countDedupDropsToday', () => {
  it('считает дубли за сегодня (МСК) → число', async () => {
    mockPrisma.activityLog.count.mockResolvedValue(4)
    const n = await countDedupDropsToday(new Date('2026-07-06T10:00:00Z'))
    expect(n).toBe(4)
    const arg = mockPrisma.activityLog.count.mock.calls[0][0]
    expect(arg.where.action).toBe('LEAD_INTAKE_DEDUPED')
    expect(arg.where.createdAt.gte).toBeInstanceOf(Date)
  })

  it('ошибка чтения → 0 (статистика не роняет отчёт)', async () => {
    mockPrisma.activityLog.count.mockRejectedValue(new Error('db down'))
    expect(await countDedupDropsToday()).toBe(0)
  })
})
