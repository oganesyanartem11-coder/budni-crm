import { prisma } from '@/lib/db/prisma'
import { isScheduledForDate } from '@/lib/orders/generate-orders'
import type { MealType } from '@prisma/client'

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

export interface DynamicConfigForDate {
  configId: string
  clientId: string
  clientName: string
  locationId: string | null
  mealType: MealType
  fixedPortions: number | null
}

/**
 * Активные DYNAMIC-конфиги, у которых расписание попадает на указанную дату.
 * Сейчас используется только в helper-е getNextActiveDayForClient — оставляем
 * экспорт на случай если понадобится отдельный «кто активен на дату X» запрос.
 */
export async function getActiveDynamicConfigsForDate(date: Date): Promise<DynamicConfigForDate[]> {
  const configs = await prisma.clientMealConfig.findMany({
    where: {
      isActive: true,
      orderType: 'DYNAMIC',
      client: { isActive: true },
      OR: [{ locationId: null }, { location: { isActive: true } }],
    },
    include: {
      client: { select: { id: true, name: true } },
    },
  })

  return configs
    .filter((c) => isScheduledForDate(c, date))
    .map((c) => ({
      configId: c.id,
      clientId: c.clientId,
      clientName: c.client.name,
      locationId: c.locationId,
      mealType: c.mealType,
      fixedPortions: c.fixedPortions,
    }))
}

const FIND_CONV_LOOKBACK_DAYS = 30

/**
 * Самая свежая BotConversation клиента, привязанная к cron-вопросу.
 * Статусы: PENDING (вопрос задан, ответа нет) или CONFIRMED (ответ принят, но
 * клиент может ответить ещё раз — это кейс B в 5.7b).
 *
 * AWAITING_MANAGER исключаем — это «спонтанный» поток без cron-вопроса.
 * EXPIRED/CANCELLED исключаем — мёртвые ветки.
 *
 * Окно 30 дней — защита: если клиент молчал месяц и старая PENDING-conv
 * висит, не пытаемся парсить ответ к ней.
 *
 * NB: helper назван findLatestBotConv (а не findLatestPendingConv) сознательно —
 * возвращает и PENDING, и CONFIRMED, чтобы handler сам различал «первый ответ»
 * vs «повторный». См. process-message.ts case A vs B.
 */
export async function findLatestBotConv(clientId: string) {
  const since = new Date(Date.now() - FIND_CONV_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  return prisma.botConversation.findFirst({
    where: {
      clientId,
      status: { in: ['PENDING', 'CONFIRMED'] },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  })
}

const NEXT_ACTIVE_DAY_LOOKAHEAD_DAYS = 14

/**
 * Следующий день, на который у клиента активен хотя бы один DYNAMIC-конфиг,
 * начиная с fromDate (включительно). Просматривает максимум 14 дней вперёд —
 * защита от сломанных расписаний (CUSTOM_DAYS без daysOfWeek, INTERVAL=0 и т.п.).
 *
 * fromDate ожидается как UTC-полночь МСК-календарной даты (тот же формат, что
 * используется в cron'е и в BotConversation.deliveryDate).
 */
export async function getNextActiveDayForClient(
  clientId: string,
  fromDate: Date
): Promise<{ date: Date; configs: DynamicConfigForDate[] } | null> {
  const configs = await prisma.clientMealConfig.findMany({
    where: {
      clientId,
      isActive: true,
      orderType: 'DYNAMIC',
      client: { isActive: true },
      OR: [{ locationId: null }, { location: { isActive: true } }],
    },
    include: {
      client: { select: { id: true, name: true } },
    },
  })

  if (configs.length === 0) return null

  const fy = fromDate.getUTCFullYear()
  const fm = fromDate.getUTCMonth()
  const fd = fromDate.getUTCDate()

  for (let i = 0; i < NEXT_ACTIVE_DAY_LOOKAHEAD_DAYS; i++) {
    const day = new Date(Date.UTC(fy, fm, fd + i, 0, 0, 0, 0))
    const matching = configs.filter((c) => isScheduledForDate(c, day))
    if (matching.length > 0) {
      return {
        date: day,
        configs: matching.map((c) => ({
          configId: c.id,
          clientId: c.clientId,
          clientName: c.client.name,
          locationId: c.locationId,
          mealType: c.mealType,
          fixedPortions: c.fixedPortions,
        })),
      }
    }
  }

  return null
}
