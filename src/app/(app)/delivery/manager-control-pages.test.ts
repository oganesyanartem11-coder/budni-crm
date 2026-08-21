import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('manager delivery control route guards', () => {
  it.each([
    './control/page.tsx',
    './control/[routeDayId]/page.tsx',
    './control/analytics/page.tsx',
  ])('%s is server-guarded for manager roles only', (file) => {
    const page = source(file)
    expect(page).toContain("requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER'])")
    expect(page).not.toContain("'COURIER'")
    expect(page).not.toContain("'CHEF'")
  })

  it('loads today control through the read-only manager model', () => {
    const page = source('./control/page.tsx')
    expect(page).toContain('getManagerDeliveryControl')
    expect(page).toContain('getMskCalendarDayUtc')
  })

  it('awaits dynamic params and delegates foreign stop validation to the route model', () => {
    const page = source('./control/[routeDayId]/page.tsx')
    expect(page).toContain('params: Promise<{ routeDayId: string }>')
    expect(page).toContain('searchParams: Promise<{ stop?: string }>')
    expect(page).toContain('getManagerCourierRouteDetail')
    expect(page).toContain('notFound()')
  })

  it('resolves the analytics period server-side and reads stop analytics', () => {
    const page = source('./control/analytics/page.tsx')
    expect(page).toContain('resolveDeliveryAnalyticsPeriod')
    expect(page).toContain('getManagerDeliveryAnalytics')
  })
})
