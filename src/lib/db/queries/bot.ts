import { prisma } from '@/lib/db/prisma'
import { isScheduledForDate } from '@/lib/orders/generate-orders'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
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
  locationId: string
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
      location: { isActive: true },
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
 * CANCELLED исключаем — мёртвая ветка.
 *
 * СЕГОДНЯШНЮЮ EXPIRED включаем СПЕЦИАЛЬНО (late-ответ): cron cutoff-notice
 * помечает молчащую сегодняшнюю conv EXPIRED в 16:00, но клиент может ответить
 * на сегодняшний вопрос «сколько на завтра?» уже после 16:00. Без этого findFirst
 * брал бы вчерашнюю CONFIRMED (deliveryDate=сегодня) и заказ создавался бы на
 * неверный день. ORDER BY createdAt DESC → сегодняшняя EXPIRED (создана cron'ом
 * в 11:00) выигрывает у вчерашней CONFIRMED. Старые EXPIRED (createdAt < сегодня
 * по МСК) НЕ включаются — их отсекает граница mskMidnightUtc(now, 0).
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
  const todayMskMidnight = mskMidnightUtc(new Date(), 0)
  return prisma.botConversation.findFirst({
    where: {
      clientId,
      createdAt: { gte: since },
      OR: [
        { status: { in: ['PENDING', 'CONFIRMED'] } },
        // Late-ответ: сегодняшняя EXPIRED (помечена cutoff-notice в 16:00).
        { status: 'EXPIRED', createdAt: { gte: todayMskMidnight } },
      ],
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
      location: { isActive: true },
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
