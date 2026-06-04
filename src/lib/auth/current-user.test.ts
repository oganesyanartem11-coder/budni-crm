import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * P7: tryGetCurrentUser НЕ редиректит — возвращает User|null по БД-сессии.
 * Те же проверки, что и в getCurrentUser (revoked/expired/inactive), но без
 * побочного redirect('/login'). Используется на /login, чтобы решить:
 * увести залогиненного на home или стереть stale-cookie.
 */
const { mockPrisma, getSessionMock } = vi.hoisted(() => ({
  mockPrisma: { session: { findUnique: vi.fn(), update: vi.fn() } },
  getSessionMock: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('./session', () => ({ getSession: getSessionMock }))

import { tryGetCurrentUser } from './current-user'

const activeUser = { id: 'u1', name: 'Артём', role: 'ADMIN_PRO', isActive: true }

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    sessionId: 's1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    user: activeUser,
    ...over,
  }
}

describe('tryGetCurrentUser', () => {
  beforeEach(() => {
    mockPrisma.session.findUnique.mockReset()
    mockPrisma.session.update.mockReset()
    getSessionMock.mockReset()
  })

  it('нет cookie → null', async () => {
    getSessionMock.mockResolvedValue(null)
    expect(await tryGetCurrentUser()).toBeNull()
    expect(mockPrisma.session.findUnique).not.toHaveBeenCalled()
  })

  it('сессия не найдена в БД → null', async () => {
    getSessionMock.mockResolvedValue({ sessionId: 's1' })
    mockPrisma.session.findUnique.mockResolvedValue(null)
    expect(await tryGetCurrentUser()).toBeNull()
  })

  it('revoked-сессия → null', async () => {
    getSessionMock.mockResolvedValue({ sessionId: 's1' })
    mockPrisma.session.findUnique.mockResolvedValue(sessionRow({ revokedAt: new Date() }))
    expect(await tryGetCurrentUser()).toBeNull()
  })

  it('expired-сессия → null', async () => {
    getSessionMock.mockResolvedValue({ sessionId: 's1' })
    mockPrisma.session.findUnique.mockResolvedValue(
      sessionRow({ expiresAt: new Date(Date.now() - 60_000) }),
    )
    expect(await tryGetCurrentUser()).toBeNull()
  })

  it('user.isActive=false → null', async () => {
    getSessionMock.mockResolvedValue({ sessionId: 's1' })
    mockPrisma.session.findUnique.mockResolvedValue(
      sessionRow({ user: { ...activeUser, isActive: false } }),
    )
    expect(await tryGetCurrentUser()).toBeNull()
  })

  it('живая валидная сессия → User (без редиректа)', async () => {
    getSessionMock.mockResolvedValue({ sessionId: 's1' })
    mockPrisma.session.findUnique.mockResolvedValue(sessionRow())
    const user = await tryGetCurrentUser()
    expect(user).toEqual(activeUser)
  })

  it('исключение БД → null (не бросает)', async () => {
    getSessionMock.mockResolvedValue({ sessionId: 's1' })
    mockPrisma.session.findUnique.mockRejectedValue(new Error('db down'))
    expect(await tryGetCurrentUser()).toBeNull()
  })
})
