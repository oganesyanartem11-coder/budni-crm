import { describe, expect, it } from 'vitest'
import { ROUTE_REFRESH_INTERVAL_MS, shouldAutoRefreshRoute } from './route-refresh-policy'

describe('courier route refresh policy', () => {
  it('polls every 30 seconds only while the document is visible', () => {
    expect(ROUTE_REFRESH_INTERVAL_MS).toBe(30_000)
    expect(shouldAutoRefreshRoute('visible')).toBe(true)
    expect(shouldAutoRefreshRoute('hidden')).toBe(false)
    expect(shouldAutoRefreshRoute('prerender')).toBe(false)
  })
})
