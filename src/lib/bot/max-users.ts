import { prisma } from '@/lib/db/prisma'

/**
 * 7.55: фундамент multi-user MAX. Единая точка резолва привязок ClientMaxUser:
 * N пользователей на клиента, ровно один isActive=true — бот пушит только ему.
 *
 * Все исходящие берут chatId через getActiveMaxChatIdForClient(clientId).
 * Все входящие резолвят клиента через resolveClientByChatId(chatId).
 * Активный пользователь переключается только в content-bearing точках через
 * promoteToActiveByChatId (реальная заявка/подтверждение), не на каждое входящее.
 */

/** Тот же include, что был у findClientByMaxChatId: активные локации + их активные mealConfigs. */
const CLIENT_BOT_INCLUDE = {
  locations: {
    where: { isActive: true },
    include: { mealConfigs: { where: { isActive: true } } },
  },
} as const

/** chatId активного MAX-пользователя клиента, или null если активного нет. */
export async function getActiveMaxChatIdForClient(clientId: string): Promise<string | null> {
  const row = await prisma.clientMaxUser.findFirst({
    where: { clientId, isActive: true },
    select: { chatId: true },
  })
  return row?.chatId ?? null
}

/**
 * Резолв клиента по chatId привязанного пользователя (замена findClientByMaxChatId).
 * Возвращает клиента с тем же include, что раньше, или null если chatId не привязан.
 * Побочно обновляет lastSeenAt привязки (fire-and-forget — не блокирует резолв и
 * не валит обработку входящего при ошибке).
 */
export async function resolveClientByChatId(chatId: string) {
  const link = await prisma.clientMaxUser.findUnique({
    where: { chatId },
    select: { id: true, clientId: true },
  })
  if (!link) return null

  void prisma.clientMaxUser
    .update({ where: { id: link.id }, data: { lastSeenAt: new Date() } })
    .catch(() => {
      /* lastSeenAt — наблюдаемость, не критично; не валим обработку входящего */
    })

  return prisma.client.findUnique({
    where: { id: link.clientId },
    include: CLIENT_BOT_INCLUDE,
  })
}

/** Клиент с активными локациями/конфигами — форма для bot-orchestrator (бывш. ClientWithBotContext). */
export type ClientWithBotContext = NonNullable<Awaited<ReturnType<typeof resolveClientByChatId>>>

/**
 * Делает пользователя chatId активным для своего клиента, остальных — неактивными.
 * Вызывается из content-bearing точек (успешная заявка/подтверждение). Идемпотентно:
 * если уже активный — ничего не меняет. Транзакция гасит всех активных у клиента,
 * затем поднимает нужного (partial-unique индекс «один активный на клиента» не
 * нарушается: на момент коммита активен ровно один).
 */
export async function promoteToActiveByChatId(chatId: string): Promise<void> {
  const link = await prisma.clientMaxUser.findUnique({
    where: { chatId },
    select: { id: true, clientId: true, isActive: true },
  })
  if (!link || link.isActive) return

  await prisma.$transaction([
    prisma.clientMaxUser.updateMany({
      where: { clientId: link.clientId, isActive: true },
      data: { isActive: false },
    }),
    prisma.clientMaxUser.update({
      where: { id: link.id },
      data: { isActive: true },
    }),
  ])
}
