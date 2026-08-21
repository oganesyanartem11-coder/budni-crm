export const ROUTE_REFRESH_INTERVAL_MS = 30_000

export function shouldAutoRefreshRoute(visibilityState: string): boolean {
  return visibilityState === 'visible'
}
