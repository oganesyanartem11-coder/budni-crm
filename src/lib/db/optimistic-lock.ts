import { prisma } from '@/lib/db/prisma'
import type { Prisma } from '@prisma/client'
import { OPTIMISTIC_LOCK_ERROR_MESSAGE } from './optimistic-lock-shared'

/**
 * 6.8b: optimistic locking на Order. Менеджеры могут одновременно открыть
 * один заказ; чтобы последний write не затирал чужие правки молча, UI
 * передаёт expectedUpdatedAt (момент когда заказ был прочитан), action
 * сверяет с актуальным БД-значением.
 *
 * Если expectedUpdatedAt не передан — не блокируем (backward compatibility
 * для старого UI и внешних API-вызовов).
 */

export class OptimisticLockError extends Error {
  constructor() {
    super(OPTIMISTIC_LOCK_ERROR_MESSAGE)
    this.name = 'OptimisticLockError'
  }
}

type TxOrPrisma = Prisma.TransactionClient | typeof prisma

/**
 * Бросает OptimisticLockError если БД-значение Order.updatedAt отличается
 * от expected (через 1-секундный grace для round-trip serialize/parse).
 *
 * Передавай tx (Prisma transaction client) если нужна консистентность внутри
 * транзакции; иначе fallback на глобальный prisma.
 */
export async function assertOrderUpdatedAt(
  orderId: string,
  expectedUpdatedAt: string | undefined,
  tx?: TxOrPrisma
): Promise<void> {
  if (!expectedUpdatedAt) return // backward-compat: old client/API call

  const expected = new Date(expectedUpdatedAt)
  if (isNaN(expected.getTime())) return // мусор от клиента — не блокируем

  const client = tx ?? prisma
  const current = await client.order.findUnique({
    where: { id: orderId },
    select: { updatedAt: true },
  })
  if (!current) return // заказа нет — пусть оригинальный action ругнётся со своим сообщением

  // 1 сек grace: serialize → parse Date в server actions через RSC может
  // потерять субмиллисекундную точность.
  const diff = Math.abs(current.updatedAt.getTime() - expected.getTime())
  if (diff > 1000) {
    throw new OptimisticLockError()
  }
}
