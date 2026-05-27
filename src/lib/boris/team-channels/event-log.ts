/**
 * logBorisEvent — fire-and-forget точка записи событий в BorisEventLog
 * (Спринт 7.16.C, ЭТАП 1).
 *
 * Триггеры (handleSpontaneous, approveMenuCycle, delivery, …) будут вызывать
 * её через `void logBorisEvent({...}).catch(...)`. Эта функция:
 *   - Никогда не throws — все ошибки тихо логируются.
 *   - При duplicate deduplKey (P2002 unique constraint) возвращает null
 *     без шума — повторный эмит того же триггера считается ожидаемым.
 *
 * Триггеры — этап 2. Сейчас функция доступна, но никто её не зовёт.
 */

import type { BorisEventLog, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { TeamEventInput } from './types'

export async function logBorisEvent(input: TeamEventInput): Promise<BorisEventLog | null> {
  try {
    return await prisma.borisEventLog.create({
      data: {
        eventType: input.eventType,
        eventDate: input.eventDate,
        clientId: input.clientId ?? null,
        orderId: input.orderId ?? null,
        menuCycleId: input.menuCycleId ?? null,
        payload: input.payload as Prisma.InputJsonValue,
        deduplKey: input.deduplKey,
      },
    })
  } catch (err) {
    // Prisma вращает P2002 при нарушении unique constraint (deduplKey).
    // Это норма — повторный триггер с тем же ключом не должен ронять flow.
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002'
    ) {
      return null
    }
    console.error('[boris/event-log] failed to log event', {
      eventType: input.eventType,
      deduplKey: input.deduplKey,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
