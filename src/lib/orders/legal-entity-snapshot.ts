import { prisma } from '@/lib/db/prisma'
import type { Prisma } from '@prisma/client'

/**
 * Подготавливает snapshot ourLegalEntityId и vatRate для нового Order.
 * Берёт значения из client.defaultOurLegalEntityId.
 *
 * Если у клиента не выбрано юрлицо отгрузки — возвращает оба null.
 * Это валидное состояние: заказ создаётся, но УПД сформировать пока нельзя.
 * UI помечает такие заказы предупреждением и предлагает выбрать юрлицо
 * через changeOrderLegalEntity.
 */
export async function getOrderLegalEntitySnapshot(clientId: string): Promise<{
  ourLegalEntityId: string | null
  vatRate: Prisma.Decimal | null
}> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      defaultOurLegalEntityId: true,
      defaultOurLegalEntity: { select: { vatRate: true } },
    },
  })

  if (!client?.defaultOurLegalEntityId) {
    return { ourLegalEntityId: null, vatRate: null }
  }

  return {
    ourLegalEntityId: client.defaultOurLegalEntityId,
    vatRate: client.defaultOurLegalEntity?.vatRate ?? null,
  }
}

/**
 * Тот же snapshot, но из переданных данных (без обращения в БД).
 * Используется когда client уже подгружен — например, в cron-генераторе FIXED,
 * где мы итерируемся по ClientMealConfig с include client.defaultOurLegalEntity.
 */
export function buildLegalEntitySnapshot(input: {
  defaultOurLegalEntityId: string | null
  defaultOurLegalEntity: { vatRate: Prisma.Decimal | null } | null
}): {
  ourLegalEntityId: string | null
  vatRate: Prisma.Decimal | null
} {
  if (!input.defaultOurLegalEntityId) {
    return { ourLegalEntityId: null, vatRate: null }
  }
  return {
    ourLegalEntityId: input.defaultOurLegalEntityId,
    vatRate: input.defaultOurLegalEntity?.vatRate ?? null,
  }
}
