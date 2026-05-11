import { prisma } from '@/lib/db/prisma'

/**
 * Возвращает клиента по MAX chat_id, со всеми активными точками
 * и активными meal-конфигами на каждой точке.
 * Используется в bot-orchestrator для парсинга ответов клиента.
 */
export async function findClientByMaxChatId(maxChatId: string) {
  return prisma.client.findUnique({
    where: { maxChatId },
    include: {
      locations: {
        where: { isActive: true },
        include: {
          mealConfigs: {
            where: { isActive: true },
          },
        },
      },
    },
  })
}

export type ClientWithBotContext = NonNullable<Awaited<ReturnType<typeof findClientByMaxChatId>>>
