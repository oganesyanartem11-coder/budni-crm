import type { OrderType, ScheduleType, PackagingType, MealType, DeliveryHorizon } from '@prisma/client'

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  DYNAMIC: 'Динамика (подтверждение)',
  FIXED: 'Фикс (постоянное число)',
  WEEKLY: 'Недельный',
}

export const ORDER_TYPE_SHORT: Record<OrderType, string> = {
  DYNAMIC: 'Динамика',
  FIXED: 'Фикс',
  WEEKLY: 'Неделя',
}

export const SCHEDULE_TYPE_LABELS: Record<ScheduleType, string> = {
  DAILY: 'Каждый день',
  WEEKDAYS: 'Будни (Пн-Пт)',
  WEEKENDS: 'Выходные (Сб-Вс)',
  CUSTOM_DAYS: 'Свои дни недели',
  ONE_TIME: 'Разовый заказ',
  INTERVAL: 'С интервалом',
}

export const PACKAGING_LABELS: Record<PackagingType, string> = {
  INDIVIDUAL: 'Порционно',
  BULK: 'Коробками',
}

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  BREAKFAST: 'Завтрак',
  LUNCH: 'Обед',
  DINNER: 'Ужин',
}

export const DELIVERY_HORIZON_LABELS: Record<DeliveryHorizon, string> = {
  NEXT_DAY: 'На следующий день',
  SAME_DAY: 'В тот же день',
}

export const WEEKDAY_NAMES_SHORT: Record<number, string> = {
  1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб', 7: 'Вс',
}
