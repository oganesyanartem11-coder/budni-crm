import { toMskDateString } from '@/lib/utils/msk-window'

/**
 * MEGA-3 (П9): резолвер cut-off клиента для конкретной даты доставки.
 *
 * Проблема: SAME-DAY клиент (доставка сегодня утром, индивидуальный
 * cut-off напр. 08:40 МСК) получал текст про «16:00», потому что cut-off
 * хардкодился глобальной константой. Этот модуль — единый источник истины
 * для «какой cut-off у этого клиента на эту доставку».
 *
 * Логика (резолв по КОНКРЕТНОЙ локации заказа, а не по всем локациям
 * клиента — иначе обычная точка унаследовала бы same-day cut-off 08:40
 * от другой точки того же клиента):
 *  - deliveryDate не «сегодня по МСК» → DEFAULT_CUTOFF (приём накануне, 16:00).
 *  - locationId === null (legacy / заказ без локации) → DEFAULT_CUTOFF.
 *  - Локация заказа найдена, АКТИВНА и sameDayDelivery=true →
 *    индивидуальный cut-off этой локации (cutoffHourMsk:cutoffMinuteMsk,
 *    fallback 16:00).
 *  - Иначе → DEFAULT_CUTOFF.
 *
 * Имена полей сверены со schema.prisma:
 *   ClientLocation.id:              String
 *   ClientLocation.sameDayDelivery: Boolean
 *   ClientLocation.cutoffHourMsk:   Int? (null → 16)
 *   ClientLocation.cutoffMinuteMsk: Int? (null → 0)
 */

export const DEFAULT_CUTOFF: CutoffTime = { hour: 16, minute: 0 }

export interface CutoffTime {
  hour: number
  minute: number
}

/** Минимальный shape локации, нужный для резолва cut-off. */
export interface LocationForCutoff {
  id: string
  isActive?: boolean
  sameDayDelivery: boolean
  cutoffHourMsk: number | null
  cutoffMinuteMsk: number | null
}

export interface ClientForCutoff {
  locations: LocationForCutoff[]
}

export interface GetClientCutoffParams {
  /** Клиент с локациями (используются только id + same-day поля). */
  client: ClientForCutoff
  /** Дата доставки (UTC-полночь МСК-дня, как в BotConversation). */
  deliveryDate: Date
  /**
   * Локация конкретного заказа. null → cut-off по умолчанию (16:00),
   * backward-compat для заказов без явной локации.
   */
  locationId: string | null
  /** Текущий момент (инъектируется для тестов; по умолчанию new Date()). */
  now?: Date
}

/**
 * Форматирует cut-off как «HH:MM» (с ведущими нулями) — для подстановки
 * в клиентские тексты вместо хардкода «16:00».
 */
export function formatCutoff(cutoff: CutoffTime): string {
  const hh = String(cutoff.hour).padStart(2, '0')
  const mm = String(cutoff.minute).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * Возвращает cut-off { hour, minute } для заказа конкретной локации на дату.
 *
 * Резолв строго по `locationId` заказа: same-day cut-off отдаётся только
 * если ИМЕННО эта локация same-day и доставка сегодня. Иначе — 16:00.
 */
export function getClientCutoffForDate({
  client,
  deliveryDate,
  locationId,
  now = new Date(),
}: GetClientCutoffParams): CutoffTime {
  const deliveryIsToday = toMskDateString(deliveryDate) === toMskDateString(now)
  if (!deliveryIsToday) {
    return { ...DEFAULT_CUTOFF }
  }

  // Локация заказа неизвестна (legacy / заказ без локации) → дефолт.
  if (!locationId) {
    return { ...DEFAULT_CUTOFF }
  }

  const location = client.locations.find((l) => l.id === locationId)
  if (!location || !location.sameDayDelivery || location.isActive === false) {
    return { ...DEFAULT_CUTOFF }
  }

  return {
    hour: location.cutoffHourMsk ?? DEFAULT_CUTOFF.hour,
    minute: location.cutoffMinuteMsk ?? DEFAULT_CUTOFF.minute,
  }
}

/**
 * Самый ранний cut-off среди активных same-day локаций клиента.
 * null → нет активной same-day локации (персональный cut-off неприменим,
 * текст оставит глобальный fallback «до 16:00»).
 * Несколько same-day локаций с разными cut-off → минимальный (самый ранний
 * дедлайн), чтобы текст не обещал больше времени, чем есть. Та же семантика
 * «min среди same-day», что в process-message.ts (КЕЙС C).
 */
export function getEarliestSameDayCutoff(
  locations: LocationForCutoff[]
): CutoffTime | null {
  const sameDay = locations.filter(
    (l) => l.sameDayDelivery && l.isActive !== false
  )
  let best: CutoffTime | null = null
  for (const l of sameDay) {
    const c: CutoffTime = {
      hour: l.cutoffHourMsk ?? DEFAULT_CUTOFF.hour,
      minute: l.cutoffMinuteMsk ?? DEFAULT_CUTOFF.minute,
    }
    if (!best || c.hour * 60 + c.minute < best.hour * 60 + best.minute) {
      best = c
    }
  }
  return best
}
