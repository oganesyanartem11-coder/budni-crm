import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'grammy'

const {
  mockRegister,
  mockRequireTelegramUser,
  mockResolveCore,
  mockFindRequest,
} = vi.hoisted(() => ({
  mockFindRequest: vi.fn(),
  mockRegister: vi.fn(),
  mockRequireTelegramUser: vi.fn(),
  mockResolveCore: vi.fn(),
}))

vi.mock('../callback-router', () => ({ registerCallbackHandler: mockRegister }))
vi.mock('@/lib/db/prisma', () => ({
  prisma: { deliveryOverrideRequest: { findUnique: mockFindRequest } },
}))
vi.mock('../identify-user', () => ({ requireTelegramUser: mockRequireTelegramUser }))
vi.mock('@/lib/delivery/delivery-override', () => ({
  resolveDeliveryOverrideRequestCore: mockResolveCore,
}))

import './delivery-override'

const manager = {
  id: 'manager-1',
  name: 'Мария',
  role: 'MANAGER' as const,
  isActive: true,
}

function handler() {
  const registered = mockRegister.mock.calls[0]?.[0]
  if (!registered) throw new Error('callback handler was not registered')
  return registered
}

function context() {
  return {
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRegister.mockClear()
  mockFindRequest.mockResolvedValue({
    courierNameSnapshot: 'Иван',
    resolvedByNameSnapshot: 'Мария',
    stop: { clientNameSnapshot: 'ХАЛВА', locationNameSnapshot: 'Офис' },
  })
  // Re-register captured at module import is restored from Vitest mock history
  // below when needed through the original first call snapshot.
})

const registeredHandler = (() => {
  const call = mockRegister.mock.calls[0]?.[0]
  if (!call) throw new Error('delivery override handler missing')
  return call
})()

describe('delivery override Telegram callback', () => {
  it('registers an isolated dovr callback scope', () => {
    expect(registeredHandler.scope).toBe('dovr')
  })

  it('maps Telegram identity explicitly and approves with that actor', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-08-12T08:05:00.000Z')
    vi.setSystemTime(now)
    const ctx = context()
    mockRequireTelegramUser.mockResolvedValue(manager)
    mockResolveCore.mockResolvedValue({
      requestId: 'override-1',
      status: 'APPROVED',
      stopDelivered: true,
      idempotent: false,
    })

    await registeredHandler.handle(ctx, 'approve', 'override-1')

    expect(mockRequireTelegramUser).toHaveBeenCalledWith(
      ctx,
      ['ADMIN_PRO', 'ADMIN', 'MANAGER'],
    )
    expect(mockResolveCore).toHaveBeenCalledWith(manager, {
      requestId: 'override-1',
      decision: 'APPROVE',
      comment: null,
      now,
    })
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      '✅ Доставка подтверждена менеджером.\nХАЛВА · Офис, курьер Иван. Решение: Мария.',
    )
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Готово' })
    const answer = ctx.answerCallbackQuery as unknown as ReturnType<typeof vi.fn>
    const edit = ctx.editMessageText as unknown as ReturnType<typeof vi.fn>
    expect(answer.mock.invocationCallOrder[0]).toBeLessThan(edit.mock.invocationCallOrder[0])
    vi.useRealTimers()
  })

  it('does no mutation when Telegram user is unknown or role-denied', async () => {
    const ctx = context()
    mockRequireTelegramUser.mockResolvedValue(null)

    await registeredHandler.handle(ctx, 'reject', 'override-1')

    expect(mockResolveCore).not.toHaveBeenCalled()
  })

  it('renders expired and repeated decisions idempotently', async () => {
    const ctx = context()
    mockRequireTelegramUser.mockResolvedValue(manager)
    mockResolveCore.mockResolvedValue({
      requestId: 'override-1',
      status: 'EXPIRED',
      stopDelivered: false,
      idempotent: false,
    })

    await registeredHandler.handle(ctx, 'approve', 'override-1')

    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('истёк'))
  })

  it('context load failure still edits with the bare status', async () => {
    const ctx = context()
    mockRequireTelegramUser.mockResolvedValue(manager)
    mockFindRequest.mockRejectedValue(new Error('db'))
    mockResolveCore.mockResolvedValue({
      requestId: 'override-1',
      status: 'REJECTED',
      stopDelivered: false,
      idempotent: true,
    })

    await registeredHandler.handle(ctx, 'reject', 'override-1')

    expect(ctx.editMessageText).toHaveBeenCalledWith('❌ Запрос отклонён менеджером.')
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Уже обработано' })
  })
})
