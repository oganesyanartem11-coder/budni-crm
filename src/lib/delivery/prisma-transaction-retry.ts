import { DeliveryStopVersionError } from './legacy-stop'

export class DeliveryTransactionConflictError extends DeliveryStopVersionError {
  constructor() {
    super()
    this.name = 'DeliveryTransactionConflictError'
  }
}

export async function runWithPrismaConflictRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const isTransactionConflict =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2034'
      if (!isTransactionConflict) throw error
      if (attempt === maxAttempts) throw new DeliveryTransactionConflictError()
    }
  }

  throw new DeliveryTransactionConflictError()
}
