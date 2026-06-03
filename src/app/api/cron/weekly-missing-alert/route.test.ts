import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * weekly-missing-alert cron: алёрт менеджеру (ADMIN_PRO) о WEEKLY-клиентах без
 * заявки на след. неделю. Мокаем prisma и notifyAllAdminProDirect; escapeHtml
 * оставляем реальной (это чистая строковая функция из того же модуля). Дёргаем
 * handler напрямую — поведение GET (withCronHeartbeat) не трогаем.
 */

const { mockPrisma, mockNotify } = vi.hoisted(() => ({
  mockPrisma: {
    client: { findMany: vi.fn() },
    weeklyOrderSubmission: { findFirst: vi.fn() },
    activityLog: { findFirst: vi.fn(), create: vi.fn() },
  },
  mockNotify: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/telegram/notify', () => ({
  notifyAllAdminProDirect: mockNotify,
  // escapeHtml — реальная реализация, чтобы тест проверял корректное
  // экранирование имени без дублирования логики.
  escapeHtml: (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}))

import { handler } from './route'

const REQ = new Request('http://x/api/cron/weekly-missing-alert')

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.activityLog.findFirst.mockResolvedValue(null)
  mockPrisma.activityLog.create.mockResolvedValue({ id: 'log_1' })
  mockNotify.mockResolvedValue({ sentTo: 1, skippedNoTelegram: 0, failed: 0 })
})

describe('weekly-missing-alert', () => {
  it('клиент без заявки → notifyAllAdminProDirect с именем и диапазоном недели', async () => {
    mockPrisma.client.findMany.mockResolvedValue([
      { id: 'c1', name: 'Кафе Будни', maxChatId: '12345' },
    ])
    mockPrisma.weeklyOrderSubmission.findFirst.mockResolvedValue(null)

    const res = await handler(REQ)
    const body = await res.json()

    expect(mockNotify).toHaveBeenCalledTimes(1)
    const text = mockNotify.mock.calls[0][0] as string
    expect(text).toContain('Кафе Будни')
    expect(text).toContain('нет заявки на след неделю')
    // Диапазон DD.MM по DD.MM (две даты в формате 2 цифры . 2 цифры).
    expect(text).toMatch(/с \d{2}\.\d{2} по \d{2}\.\d{2}/)
    expect(text.startsWith('⚠️')).toBe(true)
    expect(body.alerted).toBe(1)
  })

  it('клиент С заявкой → notifyAllAdminProDirect НЕ вызывается', async () => {
    mockPrisma.client.findMany.mockResolvedValue([
      { id: 'c1', name: 'Кафе Будни', maxChatId: '12345' },
    ])
    mockPrisma.weeklyOrderSubmission.findFirst.mockResolvedValue({ id: 'sub_1' })

    const res = await handler(REQ)
    const body = await res.json()

    expect(mockNotify).not.toHaveBeenCalled()
    expect(body.alerted).toBe(0)
    expect(body.skippedHasSubmission).toBe(1)
  })

  it('имя клиента с HTML-символами экранируется', async () => {
    mockPrisma.client.findMany.mockResolvedValue([
      { id: 'c1', name: 'A & B <Co>', maxChatId: '12345' },
    ])
    mockPrisma.weeklyOrderSubmission.findFirst.mockResolvedValue(null)

    await handler(REQ)

    const text = mockNotify.mock.calls[0][0] as string
    expect(text).toContain('A &amp; B &lt;Co&gt;')
  })

  it('idempotency: уже запускался сегодня → skip без алёртов', async () => {
    mockPrisma.activityLog.findFirst.mockResolvedValue({ id: 'ran' })

    const res = await handler(REQ)
    const body = await res.json()

    expect(body.skipped).toBe(true)
    expect(mockPrisma.client.findMany).not.toHaveBeenCalled()
    expect(mockNotify).not.toHaveBeenCalled()
  })
})
