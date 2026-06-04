import { describe, it, expect } from 'vitest'
import type { UserRole } from '@prisma/client'
import { getHomeForRole } from './roles'

describe('getHomeForRole (П7)', () => {
  it('routes COURIER to /delivery', () => {
    expect(getHomeForRole('COURIER')).toBe('/delivery')
  })

  it('routes CHEF to /production', () => {
    expect(getHomeForRole('CHEF')).toBe('/production')
  })

  it('routes ADMIN to /dashboard', () => {
    expect(getHomeForRole('ADMIN')).toBe('/dashboard')
  })

  it('routes ADMIN_PRO to /dashboard', () => {
    expect(getHomeForRole('ADMIN_PRO')).toBe('/dashboard')
  })

  it('routes MANAGER to /dashboard', () => {
    expect(getHomeForRole('MANAGER')).toBe('/dashboard')
  })

  it('covers every UserRole enum value with a non-self-looping home', () => {
    // Guards against a new role being added to the enum without a home mapping.
    const allRoles: UserRole[] = ['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF', 'COURIER']
    for (const role of allRoles) {
      const home = getHomeForRole(role)
      expect(home.startsWith('/')).toBe(true)
      // A real role must never fall through to /login (that would be a config bug).
      expect(home).not.toBe('/login')
    }
  })
})
