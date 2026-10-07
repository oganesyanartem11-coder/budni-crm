import { formatInTimeZone } from 'date-fns-tz'
import { prisma } from '@/lib/db/prisma'
import { getMondayOfWeek, shiftWeek } from '@/lib/utils/week'

/**
 * Напоминания WEEKLY-клиентам «ждём заявку на следующую неделю» (пт 10:00 и
 * 13:00 МСК) и алёрт менеджеру (пт 15:00), если заявки так и нет.
 */

const MSK_TIMEZONE = 'Europe/Moscow'
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export interface NextWeek {
  /** МСК-полночь понедельника как UTC-инстант (как weekStartDate напоминаний). */
  mondayMsk: Date
  /** UTC-полночь понедельника (@db.Date-формат deliveryDate/weekStartDate заявки). */
  mondayDay: Date
  /** «12.10–18.10» */
  label: string
}

export function getNextWeek(now: Date): NextWeek {
  const mondayMsk = shiftWeek(getMondayOfWeek(now), 1)
  const mondayDay = new Date(mondayMsk.getTime() + MSK_OFFSET_MS)
  const from = formatInTimeZone(mondayMsk, MSK_TIMEZONE, 'dd.MM')
  const to = formatInTimeZone(new Date(mondayMsk.getTime() + 6 * DAY_MS), MSK_TIMEZONE, 'dd.MM')
  return { mondayMsk, mondayDay, label: `${from}–${to}` }
}

/** Активные клиенты с активным WEEKLY-питанием и его точки/приёмы. */
export async function findWeeklyClients() {
  return prisma.client.findMany({
    where: {
      isActive: true,
      mealConfigs: { some: { orderType: 'WEEKLY', isActive: true } },
    },
    select: {
      id: true,
      name: true,
      mealConfigs: {
        where: { orderType: 'WEEKLY', isActive: true },
        select: { locationId: true, mealType: true },
      },
    },
  })
}

/**
 * Заявка на следующую неделю уже есть: «живая» недельная заявка ИЛИ хоть один
 * заказ с порциями на эту неделю по недельному питанию (менеджер внёс руками,
 * как неделю 05–11.10) — тогда клиента не дёргаем.
 */
export async function hasNextWeekRequest(
  client: { id: string; mealConfigs?: Array<{ locationId: string; mealType: string }> },
  week: NextWeek,
): Promise<boolean> {
  const submission = await prisma.weeklyOrderSubmission.findFirst({
    where: {
      clientId: client.id,
      // Приём заявки пишет UTC-полночь Пн; исторически встречалась и МСК-полночь
      // (вс 21:00Z) — ищем в пределах этих суток.
      weekStartDate: { gte: week.mondayMsk, lt: new Date(week.mondayMsk.getTime() + DAY_MS) },
      status: { in: ['PARSED', 'AUTO_CONFIRMED', 'NEEDS_REVIEW'] },
    },
    select: { id: true },
  })
  if (submission) return true

  const pairs = client.mealConfigs ?? []
  if (pairs.length === 0) return false
  const order = await prisma.order.findFirst({
    where: {
      clientId: client.id,
      deliveryDate: { gte: week.mondayDay, lt: new Date(week.mondayDay.getTime() + 7 * DAY_MS) },
      status: { not: 'CANCELLED' },
      portions: { gt: 0 },
      OR: pairs.map((p) => ({ locationId: p.locationId, mealType: p.mealType as never })),
    },
    select: { id: true },
  })
  return order !== null
}

export type ReminderSlot = 'morning' | 'afternoon'

/** Пт 10:00 — первое напоминание, 13:00 — повтор тем, кто не ответил. */
export function weeklyReminderText(slot: ReminderSlot, week: NextWeek): string {
  const body =
    slot === 'morning'
      ? `Здравствуйте! Ждём заявку на следующую неделю (${week.label}). Пришлите, пожалуйста, фото или текст: дни и количество порций.`
      : `Напоминаем: заявку на следующую неделю (${week.label}) ещё не получили. Пришлите, пожалуйста, дни и количество порций — так мы успеем всё закупить и приготовить.`
  return `${body}\n\n— Будни`
}
