import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('./_components/issue-dialog.tsx', import.meta.url),
  'utf8',
)

describe('IssueDialog mobile accessibility contract', () => {
  it('associates visible labels with the reason and comment controls', () => {
    expect(source).toContain('htmlFor="delivery-issue-reason"')
    expect(source).toContain('id="delivery-issue-reason"')
    expect(source).toContain('htmlFor="delivery-issue-comment"')
    expect(source).toContain('id="delivery-issue-comment"')
  })

  it('keeps every dialog action at least 44px tall, including close', () => {
    expect(source).toContain('[&>button]:min-h-11')
    expect(source).toContain('[&>button]:min-w-11')
    expect(source.match(/min-h-11/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })

  it('uses readable mobile text and AA-safe action colors', () => {
    expect(source).toContain('text-fg-muted font-normal')
    expect(source).toContain('resize-none rounded-xl border border-border bg-bg px-3 py-2 text-base')
    expect(source).toContain('rounded-pill bg-primary')
    expect(source).not.toContain('rounded-pill bg-danger')
  })
})
