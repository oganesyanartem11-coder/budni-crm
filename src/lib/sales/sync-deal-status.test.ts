import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Sprint 8.0: стадия воронки ↔ dealStatus. syncPipelineFromDealStatus зовётся из
 * Бориса-Директа (markDealWon) — не бросает и не пишет dealStatus.
 */

const { mockPrisma, mockTrackError } = vi.hoisted(() => ({
  mockPrisma: {
    landingLead: { findUnique: vi.fn(), update: vi.fn() },
    salesActivity: { create: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
  mockTrackError: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/errors/tracker', () => ({ trackError: mockTrackError }))

import { applyPipelineStatus, syncPipelineFromDealStatus } from './sync-deal-status'

const NOW = new Date('2026-09-24T09:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops))
  mockPrisma.landingLead.update.mockResolvedValue({ id: 'lead-1' })
  mockPrisma.salesActivity.create.mockResolvedValue({ id: 'act-1' })
  mockTrackError.mockResolvedValue(undefined)
})

describe('syncPipelineFromDealStatus (Борис → CRM)', () => {
  it('WON из «Пробный день» → стадия WON + wonAt, событие «(через Бориса-Директ)», dealStatus не пишем', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue({ pipelineStatus: 'TRIAL', wonAt: null })
    await syncPipelineFromDealStatus('lead-1', 'WON', { authorLabel: 'Борис-Директ' })
    const data = mockPrisma.landingLead.update.mock.calls[0][0].data
    expect(data.pipelineStatus).toBe('WON')
    expect(data.wonAt).toBeInstanceOf(Date)
    expect(data).not.toHaveProperty('dealStatus')
    expect(mockPrisma.salesActivity.create.mock.calls[0][0].data).toMatchObject({
      kind: 'STATUS_CHANGE',
      text: 'Стадия: Пробный день → Клиент (через Бориса-Директ)',
    })
  })

  it('уже WON (повтор команды) → ничего не пишем', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue({ pipelineStatus: 'WON', wonAt: NOW })
    await syncPipelineFromDealStatus('lead-1', 'WON', { authorLabel: 'Борис-Директ' })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockPrisma.landingLead.update).not.toHaveBeenCalled()
  })

  it('NONE («сделка … отмена») → стадию не трогаем', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue({ pipelineStatus: 'WON', wonAt: NOW })
    await syncPipelineFromDealStatus('lead-1', 'NONE')
    expect(mockPrisma.landingLead.update).not.toHaveBeenCalled()
    expect(mockPrisma.salesActivity.create).not.toHaveBeenCalled()
  })

  it('падение prisma → не бросает, trackError(warn)', async () => {
    mockPrisma.landingLead.findUnique.mockRejectedValue(new Error('db down'))
    await expect(syncPipelineFromDealStatus('lead-1', 'WON')).resolves.toBeUndefined()
    expect(mockTrackError).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
  })

  it('заявки нет → тихо ничего', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue(null)
    await syncPipelineFromDealStatus('ghost', 'WON')
    expect(mockPrisma.landingLead.update).not.toHaveBeenCalled()
  })
})

describe('applyPipelineStatus (CRM → Борис)', () => {
  const lead = (over: Record<string, unknown> = {}) => ({
    pipelineStatus: 'NEW',
    wonAt: null,
    dealAmount: null,
    lostReason: null,
    lostComment: null,
    ...over,
  })

  it('NEW → IN_PROGRESS: dealStatus IN_PROGRESS, событие «Стадия: Новая → В работе» + хвост note', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue(lead())
    const r = await applyPipelineStatus('lead-1', 'IN_PROGRESS', { authorId: 'u1', note: ' (через Telegram)', now: NOW })
    expect(r).toEqual({ changed: true, from: 'NEW', to: 'IN_PROGRESS' })
    expect(mockPrisma.landingLead.update.mock.calls[0][0].data).toMatchObject({
      pipelineStatus: 'IN_PROGRESS',
      dealStatus: 'IN_PROGRESS',
      lastActivityAt: NOW,
    })
    expect(mockPrisma.salesActivity.create.mock.calls[0][0].data).toMatchObject({
      kind: 'STATUS_CHANGE',
      text: 'Стадия: Новая → В работе (через Telegram)',
      authorId: 'u1',
    })
  })

  it('→ WON с суммой: wonAt, dealStatus WON, событие «Стал клиентом · 120 000 ₽/мес»', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue(lead({ pipelineStatus: 'CONTRACT' }))
    await applyPipelineStatus('lead-1', 'WON', { dealAmount: 120000, now: NOW })
    expect(mockPrisma.landingLead.update.mock.calls[0][0].data).toMatchObject({
      pipelineStatus: 'WON',
      dealStatus: 'WON',
      wonAt: NOW,
      dealAmount: 120000,
      lostAt: null,
    })
    const text = mockPrisma.salesActivity.create.mock.calls[0][0].data.text as string
    // Intl ru-RU разделяет разряды неразрывным пробелом.
    expect(text.replace(/\s/g, ' ')).toBe('Стал клиентом · 120 000 ₽/мес')
  })

  it('возврат из LOST в активную стадию сбрасывает итоги сделки', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue(
      lead({ pipelineStatus: 'LOST', lostReason: 'EXPENSIVE', lostComment: 'дорого' })
    )
    await applyPipelineStatus('lead-1', 'IN_PROGRESS', { now: NOW })
    expect(mockPrisma.landingLead.update.mock.calls[0][0].data).toMatchObject({
      pipelineStatus: 'IN_PROGRESS',
      dealStatus: 'IN_PROGRESS',
      wonAt: null,
      lostAt: null,
      lostReason: null,
      lostComment: null,
    })
  })

  it('та же стадия без доп. полей → ничего не пишем, changed:false', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue(lead({ pipelineStatus: 'TRIAL' }))
    const r = await applyPipelineStatus('lead-1', 'TRIAL', { now: NOW })
    expect(r).toEqual({ changed: false, from: 'TRIAL', to: 'TRIAL' })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('заявки нет → бросает (Core проверяет раньше)', async () => {
    mockPrisma.landingLead.findUnique.mockResolvedValue(null)
    await expect(applyPipelineStatus('ghost', 'WON')).rejects.toThrow('Заявка не найдена')
  })
})
