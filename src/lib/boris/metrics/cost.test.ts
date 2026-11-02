import { describe, expect, it } from 'vitest'
import { computeBorisCostUsd } from './cost'

describe('стоимость Бориса', () => {
  it('Luna учитывает вход, выход и кеш по собственным тарифам', () => {
    expect(computeBorisCostUsd(1_000_000, 1_000_000, 1_000_000, 1_000_000, 'gpt-6-luna')).toBe(0.735)
  })
  it('сохраняет прежний тариф при Claude rollback', () => {
    expect(computeBorisCostUsd(1_000_000, 1_000_000, 0, 0, 'claude-sonnet-5')).toBe(18)
  })
  it('округляет до точности БД', () => {
    expect(computeBorisCostUsd(100, 10, 0, 0, 'gpt-6-luna')).toBe(0.000015)
  })
})
