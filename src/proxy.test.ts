import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * P7: proxy НЕ должен редиректить /login→/dashboard.
 *
 * Корень петли: proxy.verifyToken проверяет только подпись JWT (stateless), а
 * getCurrentUser — БД-сессию. При живой JWT-cookie с revoked БД-сессией
 * getCurrentUser слал /dashboard→/login, а старый proxy слал /login→/dashboard
 * → ∞. Фикс: встречный редирект удалён, /login проходит свободно.
 *
 * jwtVerify мокаем, чтобы детерминированно управлять isAuthenticated.
 */
const { jwtVerifyMock } = vi.hoisted(() => ({ jwtVerifyMock: vi.fn() }))
vi.mock('jose', () => ({ jwtVerify: jwtVerifyMock }))

import { proxy } from './proxy'

function makeRequest(path: string, withCookie: boolean): NextRequest {
  const headers = new Headers()
  if (withCookie) headers.set('cookie', 'budni_session=some.jwt.token')
  return new NextRequest(new URL(`http://localhost${path}`), { headers })
}

/** NextResponse.next() не ставит Location; NextResponse.redirect() — ставит. */
function locationOf(res: Response): string | null {
  return res.headers.get('location')
}

describe('proxy P7 — петля /login↔/dashboard разорвана', () => {
  beforeEach(() => {
    jwtVerifyMock.mockReset()
  })

  it('/login без cookie → пропускает (next), без редиректа', async () => {
    const res = await proxy(makeRequest('/login', false))
    expect(locationOf(res)).toBeNull()
    expect(jwtVerifyMock).not.toHaveBeenCalled()
  })

  it('/login с НЕВАЛИДНОЙ cookie → пропускает (НЕ редиректит на /dashboard)', async () => {
    jwtVerifyMock.mockRejectedValue(new Error('bad signature'))
    const res = await proxy(makeRequest('/login', true))
    expect(locationOf(res)).toBeNull()
  })

  it('/login с ВАЛИДНОЙ cookie → пропускает (login сам решит, proxy НЕ редиректит)', async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sessionId: 's1' } })
    const res = await proxy(makeRequest('/login', true))
    // Ключевой кейс: раньше тут был redirect('/dashboard') — теперь его нет.
    expect(locationOf(res)).toBeNull()
  })

  it('/dashboard без cookie → redirect /login', async () => {
    const res = await proxy(makeRequest('/dashboard', false))
    expect(locationOf(res)).toContain('/login')
  })

  it('/dashboard с валидной cookie → пропускает (next), БД-проверку делает getCurrentUser', async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sessionId: 's1' } })
    const res = await proxy(makeRequest('/dashboard', true))
    expect(locationOf(res)).toBeNull()
  })
})
