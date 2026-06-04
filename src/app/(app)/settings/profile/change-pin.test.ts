import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * П5 changePin. Мокаем:
 *  - prisma (user.findUnique, $transaction)
 *  - getCurrentUser → {id:'me', role:'MANAGER'} (любая роль вправе менять свой PIN)
 *  - verifyPin / createPinFields из pin.ts (НЕ дёргаем bcrypt в юните)
 *  - isValidPinFormat — реальный (ровно 4 цифры), берём из vi.importActual,
 *    чтобы тест на «3 цифры» бил по той же логике, что и прод.
 *
 * P2002-коллизия (PIN @unique) моделируется реальным
 * Prisma.PrismaClientKnownRequestError, который ловит catch в действии.
 */

import { Prisma } from '@prisma/client'

const { mockPrisma, mockGetCurrentUser, mockVerifyPin, mockCreatePinFields } =
  vi.hoisted(() => ({
    mockPrisma: {
      user: { findUnique: vi.fn(), update: vi.fn() },
      session: { updateMany: vi.fn() },
      activityLog: { create: vi.fn() },
      $transaction: vi.fn(),
    },
    mockGetCurrentUser: vi.fn(),
    mockVerifyPin: vi.fn(),
    mockCreatePinFields: vi.fn(),
  }))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mockGetCurrentUser }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/pin', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/pin')>(
    '@/lib/auth/pin'
  )
  return {
    isValidPinFormat: actual.isValidPinFormat, // реальный: /^\d{4}$/
    verifyPin: mockVerifyPin,
    createPinFields: mockCreatePinFields,
  }
})

import { changePin } from './actions'

const ME = { id: 'me', role: 'MANAGER' as const }

beforeEach(() => {
  vi.clearAllMocks()
  mockGetCurrentUser.mockResolvedValue(ME)
  mockPrisma.user.findUnique.mockResolvedValue({ id: 'me', pinHash: 'HASH' })
  mockCreatePinFields.mockResolvedValue({
    pinHash: 'NEWHASH',
    pinLookupHash: 'NEWLOOKUP',
  })
  mockPrisma.$transaction.mockResolvedValue([])
})

describe('changePin', () => {
  it('верный currentPin + валидный newPin → ok, лог PIN_CHANGED, сессии отозваны', async () => {
    mockVerifyPin.mockResolvedValue(true)

    const r = await changePin('1234', '5678')

    expect(r.ok).toBe(true)
    expect(mockVerifyPin).toHaveBeenCalledWith('1234', 'HASH')
    expect(mockCreatePinFields).toHaveBeenCalledWith('5678')
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mockPrisma.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'PIN_CHANGED',
          entityId: 'me',
          payload: { userId: 'me' },
        }),
      })
    )
  })

  it('неверный currentPin → «Текущий PIN неверный», без мутации', async () => {
    mockVerifyPin.mockResolvedValue(false)

    const r = await changePin('0000', '5678')

    expect(r).toEqual({ ok: false, error: 'Текущий PIN неверный' })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('newPin из 3 цифр → отклонён по формату (verifyPin даже не зовётся)', async () => {
    const r = await changePin('1234', '567')

    expect(r).toEqual({
      ok: false,
      error: 'Новый PIN должен состоять из 4 цифр',
    })
    expect(mockVerifyPin).not.toHaveBeenCalled()
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('newPin === currentPin → отклонён', async () => {
    mockVerifyPin.mockResolvedValue(true)

    const r = await changePin('1234', '1234')

    expect(r).toEqual({ ok: false, error: 'Новый PIN совпадает с текущим' })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('коллизия PIN (P2002 на @unique) → дружелюбная ошибка, без краша', async () => {
    mockVerifyPin.mockResolvedValue(true)
    mockPrisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    )

    const r = await changePin('1234', '5678')

    expect(r).toEqual({ ok: false, error: 'Этот PIN уже занят. Выберите другой.' })
  })
})
