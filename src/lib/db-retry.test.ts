import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { withDbRetry } from './db-retry'

/**
 * P1001-фикс: withDbRetry ретраит ТОЛЬКО транспортные ошибки доступности БД
 * (P1001/P1002 — cold-start Neon), бизнес-ошибки пробрасывает сразу.
 *
 * Math.random мокаем в 0 (детерминированный jitter), baseDelayMs=1 — тесты
 * не ждут реальных секунд.
 */

function dbError(code: string, message?: string): Error & { code: string } {
  const e = new Error(message ?? `db error ${code}`) as Error & { code: string }
  e.code = code
  return e
}

const FAST = { baseDelayMs: 1 } as const

describe('withDbRetry', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('P1001 на 1-й попытке + успех на 2-й → возвращает результат, один warn', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(dbError('P1001', "Can't reach database server"))
      .mockResolvedValueOnce('ok')

    const result = await withDbRetry(fn, { ...FAST, maxAttempts: 3 })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('3x P1001 → пробрасывает последнюю ошибку, fn вызван maxAttempts раз', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(dbError('P1001'))

    await expect(withDbRetry(fn, { ...FAST, maxAttempts: 3 })).rejects.toMatchObject({
      code: 'P1001',
    })
    expect(fn).toHaveBeenCalledTimes(3)
    // Между 3 попытками — 2 паузы → 2 warn.
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it('не-P1001 (P2002 constraint) → пробрасывает сразу, без ретрая', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(dbError('P2002', 'Unique constraint failed'))

    await expect(withDbRetry(fn, { ...FAST, maxAttempts: 3 })).rejects.toMatchObject({
      code: 'P2002',
    })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('P1002 (timed out) → тоже ретраит', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(dbError('P1002', 'database server timed out'))
      .mockResolvedValueOnce('warm')

    const result = await withDbRetry(fn, { ...FAST, maxAttempts: 3 })

    expect(result).toBe('warm')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('P1001 по тексту сообщения (без code) → ретраит', async () => {
    const plain = new Error("Can't reach database server at neon:5432")
    const fn = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(plain)
      .mockResolvedValueOnce(42)

    const result = await withDbRetry(fn, { ...FAST, maxAttempts: 2 })
    expect(result).toBe(42)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('maxAttempts:1 → одна попытка, ретрай не делается даже на P1001', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(dbError('P1001'))

    await expect(withDbRetry(fn, { ...FAST, maxAttempts: 1 })).rejects.toMatchObject({
      code: 'P1001',
    })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('успех с первого раза → fn один раз, без warn', async () => {
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue('first-try')
    const result = await withDbRetry(fn, FAST)
    expect(result).toBe('first-try')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(console.warn).not.toHaveBeenCalled()
  })
})
