import { describe, it, expect } from 'vitest'

describe('GREETING_TEXT (smoke)', () => {
  it('файл greeting.ts грузится без ошибок import', async () => {
    const mod = await import('./greeting')
    expect(typeof mod.handleMyChatMember).toBe('function')
  })
})
