import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const stopSource = readFileSync(
  new URL('./_components/courier-stop-screen.tsx', import.meta.url),
  'utf8',
)
const routeSource = readFileSync(
  new URL('./_components/courier-route-screen.tsx', import.meta.url),
  'utf8',
)

describe('courier UX review regressions', () => {
  it('keeps normal-size text on AA-safe solid token colors', () => {
    expect(stopSource).not.toContain('text-success-fg/80')
    expect(routeSource).not.toContain('text-success-fg/80')
    expect(stopSource).not.toContain('text-fg-subtle')
  })

  it('treats the override form as a keyboard-accessible disclosure', () => {
    expect(stopSource).toContain('aria-expanded={overrideOpen}')
    expect(stopSource).toContain('aria-controls="delivery-override-panel"')
    expect(stopSource).toContain('id="delivery-override-panel"')
    expect(stopSource).toContain('ref={overrideTriggerRef}')
    expect(stopSource).toContain('ref={overrideCommentRef}')
  })
})
