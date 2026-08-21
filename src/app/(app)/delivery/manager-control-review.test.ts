import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('manager-control review regressions', () => {
  it('remounts controlled stop actions when the stop or persisted version changes', () => {
    const detail = source('./_components/manager-route-detail-screen.tsx')
    expect(detail).toContain('key={`${stop.id}:${stop.version}:')
  })

  it('reports the specific pending mutation instead of changing an unrelated label', () => {
    const actions = source('./_components/manager-stop-actions.tsx')
    expect(actions).toContain("type ActiveAction = 'assignment' | 'approve' | 'reject'")
    expect(actions).toContain("activeAction === 'approve' ? 'Подтверждаем…'")
    expect(actions).toContain("activeAction === 'reject' ? 'Отклоняем…'")
  })

  it('announces manual refresh only after the transition has completed', () => {
    const refresh = source('./_components/route-refresh-control.tsx')
    expect(refresh).toContain("setLiveAnnouncement('')")
    expect(refresh).toContain('sawPendingRefresh.current = true')
    expect(refresh).toContain('if (isPending)')
    expect(refresh).toContain('if (!sawPendingRefresh.current || !announceAfterRefresh.current) return')
    expect(refresh).toContain('window.setTimeout')
    expect(refresh.indexOf('if (!sawPendingRefresh.current')).toBeLessThan(
      refresh.indexOf('setLiveAnnouncement(announcementText)'),
    )
  })

  it('keeps desktop visual order aligned with keyboard focus order', () => {
    const detail = source('./_components/manager-route-detail-screen.tsx')
    expect(detail).not.toContain('xl:order-')
  })

  it('moves focus as well as scroll position when jumping to couriers', () => {
    const screen = source('./_components/manager-control-screen.tsx')
    const jump = source('./_components/courier-list-jump.tsx')
    expect(screen).toContain('<CourierListJump count={data.couriers.length} />')
    expect(screen).toContain('tabIndex={-1}')
    expect(jump).toContain("document.getElementById('courier-routes')")
    expect(jump).toContain('target.focus({ preventScroll: true })')
    expect(jump).toContain("target.scrollIntoView({ block: 'start' })")
  })
})
