import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Sprint 8.0: hook «заявка появилась». Главный контракт — никогда не бросает
 * (вызывается из /api/leads/intake и «Борис, звонок»).
 */

const { mockPrisma, mockTrackError } = vi.hoisted(() => ({
  mockPrisma: {
    landingLead: { findUnique: vi.fn(), update: vi.fn() },
    salesTask: { create: vi.fn(), findFirst: vi.fn() },
    salesActivity: { create: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
  mockTrackError: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/errors/tracker', () => ({ trackError: mockTrackError }))

import { onLeadCreated, incomingText, findFirstOpenTaskId } from './on-lead-created'

// 12:00 МСК — рабочее время → задача через 15 минут.
const NOW = new Date('2026-09-24T09:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops))
  mockPrisma.salesTask.create.mockResolvedValue({ id: 'task-auto' })
  mockPrisma.salesActivity.create.mockResolvedValue({ id: 'act-1' })
  mockPrisma.landingLead.update.mockResolvedValue({ id: 'lead-1' })
  mockTrackError.mockResolvedValue(undefined)
})

describe('incomingText', () => {
  it('сайт: форма + источник; без источника — без хвоста', () => {
    expect(incomingText('site', { formType: 'quiz', source: 'chef' })).toBe(
      'Заявка с сайта: квиз · Шеф Иван — Заказать дегустацию'
    )
    expect(incomingText('site', { formType: 'popup', source: null })).toBe('Заявка с сайта: попап')
  })
  it('звонок через Бориса / вручную', () => {
    expect(incomingText('boris_call', { formType: 'phone_call', source: 'boris_call_intake' })).toBe(
      'Звонок (через Бориса)'
    )
    expect(incomingText('manual', { formType: 'manual', source: 'manual-phone' })).toBe('Заведена вручную')
  })
})

describe('onLeadCreated', () => {
  it('создаёт INCOMING + задачу «Связаться» на nextContactSlot + lastActivityAt', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue({ id: 'lead-1', formType: 'popup', source: null })
    const r = await onLeadCreated({ leadId: 'lead-1', source: 'site', now: NOW })
    expect(r).toEqual({ ok: true, taskId: 'task-auto' })
    expect(mockPrisma.salesTask.create.mock.calls[0][0].data).toEqual({
      leadId: 'lead-1',
      type: 'CALL',
      title: 'Связаться',
      dueAt: new Date(NOW.getTime() + 15 * 60 * 1000),
      assigneeId: null,
      createdById: null,
    })
    expect(mockPrisma.salesActivity.create.mock.calls[0][0].data).toMatchObject({
      kind: 'INCOMING',
      text: 'Заявка с сайта: попап',
      authorId: null,
    })
    expect(mockPrisma.landingLead.update.mock.calls[0][0].data).toEqual({ lastActivityAt: NOW })
  })

  it('actorUserId → автор события, исполнитель и создатель задачи', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue({ id: 'lead-1', formType: 'manual', source: 'manual-max' })
    await onLeadCreated({ leadId: 'lead-1', source: 'manual', actorUserId: 'u1', now: NOW })
    expect(mockPrisma.salesTask.create.mock.calls[0][0].data).toMatchObject({ assigneeId: 'u1', createdById: 'u1' })
    expect(mockPrisma.salesActivity.create.mock.calls[0][0].data.authorId).toBe('u1')
  })

  it('падение prisma → НЕ бросает, ok:false, trackError(level error)', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue({ id: 'lead-1', formType: 'popup', source: null })
    mockPrisma.$transaction.mockRejectedValue(new Error('db down'))
    const r = await onLeadCreated({ leadId: 'lead-1', source: 'site', now: NOW })
    expect(r).toEqual({ ok: false })
    expect(mockTrackError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', extra: { source: 'sales/onLeadCreated', leadId: 'lead-1' } })
    )
  })

  it('заявки нет → ok:false, не бросает', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue(null)
    await expect(onLeadCreated({ leadId: 'ghost', source: 'boris_call' })).resolves.toEqual({ ok: false })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockTrackError).toHaveBeenCalledTimes(1)
  })
})

describe('findFirstOpenTaskId', () => {
  it('ближайшая открытая по dueAt; ошибка → null', async () => {
    mockPrisma.salesTask.findFirst.mockResolvedValueOnce({ id: 't-1' })
    expect(await findFirstOpenTaskId('lead-1')).toBe('t-1')
    expect(mockPrisma.salesTask.findFirst.mock.calls[0][0]).toMatchObject({
      where: { leadId: 'lead-1', doneAt: null },
      orderBy: { dueAt: 'asc' },
    })
    mockPrisma.salesTask.findFirst.mockRejectedValueOnce(new Error('db down'))
    expect(await findFirstOpenTaskId('lead-1')).toBeNull()
  })
})
