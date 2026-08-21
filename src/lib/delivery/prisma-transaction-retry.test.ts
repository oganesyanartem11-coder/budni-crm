import { describe, expect, it, vi } from 'vitest'
import { DELIVERY_STOP_VERSION_ERROR } from './legacy-stop'
import {
  DeliveryTransactionConflictError,
  runWithPrismaConflictRetry,
} from './prisma-transaction-retry'

function prismaConflict() {
  return Object.assign(new Error('serialization conflict'), { code: 'P2034' })
}

describe('runWithPrismaConflictRetry', () => {
  it('retries one P2034 conflict and returns the successful result', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(prismaConflict())
      .mockResolvedValueOnce('ok')

    await expect(runWithPrismaConflictRetry(operation)).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('throws a neutral typed conflict after three total P2034 attempts', async () => {
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(prismaConflict())
    const result = runWithPrismaConflictRetry(operation)

    await expect(result).rejects.toEqual(
      expect.objectContaining({
        name: 'DeliveryTransactionConflictError',
        message: DELIVERY_STOP_VERSION_ERROR,
      }),
    )
    await expect(result).rejects.toBeInstanceOf(
      DeliveryTransactionConflictError,
    )
    expect(operation).toHaveBeenCalledTimes(3)
  })

  it('does not retry non-P2034 errors', async () => {
    const unexpected = Object.assign(new Error('database unavailable'), { code: 'P1001' })
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(unexpected)

    await expect(runWithPrismaConflictRetry(operation)).rejects.toBe(unexpected)
    expect(operation).toHaveBeenCalledOnce()
  })
})
