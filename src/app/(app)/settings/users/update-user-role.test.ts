import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * П4 updateUserRole. Мокаем:
 *  - prisma (user.findUnique/update, activityLog.create, $transaction)
 *  - requireRole из current-user — у нас два сценария:
 *    a) ADMIN_PRO → возвращает юзера {id:'me', role:'ADMIN_PRO'}
 *    b) не-PRO → requireRole редиректит (throw), как реальный redirect()
 *  - createPinFields/generateUniquePin/getTelegramEnv замоканы как no-op,
 *    чтобы импорт actions.ts не тянул реальные зависимости.
 */

const { mockPrisma, mockRequireRole } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    activityLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  mockRequireRole: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/pin', () => ({
  createPinFields: vi.fn(),
  generateUniquePin: vi.fn(),
}))
vi.mock('@/lib/telegram/env', () => ({ getTelegramEnv: vi.fn() }))
vi.mock('ua-parser-js', () => ({ UAParser: vi.fn() }))

import { updateUserRole } from './actions'

const ME = { id: 'me', role: 'ADMIN_PRO' as const }

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireRole.mockResolvedValue(ME)
  // $transaction([...]) — просто резолвится, как pgbouncer-safe массив-форма.
  mockPrisma.$transaction.mockResolvedValue([])
})

describe('updateUserRole', () => {
  it('ADMIN_PRO меняет роль другого юзера → ok + лог USER_ROLE_CHANGED', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'MANAGER' })

    const r = await updateUserRole('u1', 'CHEF')

    expect(r.ok).toBe(true)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    // Лог содержит fromRole/toRole.
    expect(mockPrisma.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'USER_ROLE_CHANGED',
          entityId: 'u1',
          payload: { userId: 'u1', fromRole: 'MANAGER', toRole: 'CHEF' },
        }),
      })
    )
  })

  it('не-PRO (requireRole редиректит) → action не доходит до мутации', async () => {
    // requireRole в реале вызывает redirect('/dashboard'), который throw'ит
    // спец-исключение. Моделируем как throw.
    mockRequireRole.mockRejectedValueOnce(new Error('NEXT_REDIRECT'))

    await expect(updateUserRole('u1', 'CHEF')).rejects.toThrow('NEXT_REDIRECT')
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('self-downgrade (свой id, роль не ADMIN_PRO) → ошибка', async () => {
    const r = await updateUserRole('me', 'ADMIN')

    expect(r).toEqual({ ok: false, error: 'Нельзя понизить собственную роль' })
    // До БД не дошли.
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('свой id, но роль остаётся ADMIN_PRO → разрешено (idempotent no-op)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'me', role: 'ADMIN_PRO' })

    const r = await updateUserRole('me', 'ADMIN_PRO')

    expect(r.ok).toBe(true)
    // Роль не изменилась → транзакцию не запускаем.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('несуществующий юзер → ошибка «не найден»', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null)

    const r = await updateUserRole('ghost', 'CHEF')

    expect(r).toEqual({ ok: false, error: 'Пользователь не найден' })
  })
})
