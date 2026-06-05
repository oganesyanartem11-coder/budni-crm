/**
 * Типы для Командного Бориса (Спринт 7.16.C, ЭТАП 1 — инфра).
 *
 * Четыре канала озвучки в групповой чат команды:
 *   - LIVE     — точечное сообщение по одному горячему событию (спасибо, рекорд, …)
 *   - EVENING  — вечерний итог дня (один AI-пост в 20:00 МСК)
 *   - FRIDAY   — пятничный недельный обзор (всегда пишет)
 *   - ALERT    — экстренный пуш-сигнал (urgent + доставка скоро)
 *
 * Триггеры событий, cron-роуты и UI — следующие этапы. Здесь только
 * shape'ы и публичные DTO, которые AI-formatter уже умеет читать.
 */
import type { BorisEventLog, BorisEventType } from '@prisma/client'

export type TeamChannel = 'LIVE' | 'EVENING' | 'FRIDAY' | 'ALERT'

/**
 * Вход для logBorisEvent — фактаж который триггер хочет положить в БД.
 * deduplKey должен быть детерминированным по триггерному событию
 * (например `THANKS-<conversationId>-<msgHash>`), чтобы повторный
 * вызов того же триггера не плодил дубль (unique constraint в схеме).
 */
export interface TeamEventInput {
  eventType: BorisEventType
  eventDate: Date
  clientId?: string
  orderId?: string
  menuCycleId?: string
  payload: Record<string, unknown>
  deduplKey: string
}

/**
 * Одна строка из «по клиентам сегодня/завтра» — сырой агрегат для AI.
 */
export interface ClientOrderAggregate {
  clientId: string
  clientName: string
  portions: number
}

/**
 * Аггрегат тонов из ClientAlertLog за 48ч (для LIVE / EVENING).
 * Источник — таблица `ClientAlertLog`, поле `tone` ∈ {rude, urgent, null}.
 */
export interface ToneSummary {
  thanks: number
  rude: number
  urgent: number
}

/**
 * Контекст одного МСК-дня для каналов LIVE и EVENING.
 *
 * Собирается в context-builder.buildDayContext. Это весь сырой фактаж
 * который AI читает чтобы решить: писать или молчать, и если писать —
 * какие цифры/имена включить.
 */
export interface DayContext {
  /** UTC-полночь МСК-дня (как у Order.deliveryDate). */
  date: Date
  /** Заказы СЕГОДНЯ (deliveryDate=date, ACTIVE+DELIVERED). */
  today: {
    portionsTotal: number
    /**
     * Выручка по ЕДЕ (sum totalPrice). Историческое поле — формула не менялась.
     * Совпадает с foodRevenueRub (alias для совместимости с потребителями).
     */
    revenueRub: number
    /** Явный алиас food-выручки (Волна 4). */
    foodRevenueRub: number
    /** Сервисная выручка (доставка) за день. Волна 4: отдельное поле. */
    deliveryRevenueRub: number
    /** food + delivery — общий объём для озвучки (НЕ для маржи). */
    totalRevenueRub: number
    materialCostRub: number
    daysWithoutMenu: number
    byClient: ClientOrderAggregate[]
  }
  /** Заказы ЗАВТРА (deliveryDate=date+1, ACTIVE). */
  tomorrow: {
    portionsTotal: number
    pendingConfirmation: number
    byClient: ClientOrderAggregate[]
  }
  /** Все события из BorisEventLog за этот МСК-день (emittedTo=null = ещё не озвучены). */
  events: BorisEventLog[]
  /** Тоны за последние 48ч в ClientAlertLog. */
  tones: ToneSummary
  /** Среднее portionsTotal по 4 предыдущим финансовым неделям (Сб-Пт), на ту же weekday. */
  fourWeekAveragePortions: number | null
  /** Объём в пределах ±10% средней недели → день «обычный». */
  isOrdinaryDay: boolean
  /** portionsTotal сегодня > max(portionsTotal за последние 4 фин.недели) → рекорд. */
  isRecordDay: boolean
}

/**
 * Контекст финансовой недели (Сб-Пт) для канала FRIDAY.
 */
export interface WeekContext {
  weekFrom: Date
  weekTo: Date
  portionsTotal: number
  /** Выручка по ЕДЕ за неделю — историческое поле, формула не менялась. */
  revenueRub: number
  /** Явный алиас food-выручки (Волна 4). */
  foodRevenueRub: number
  /** Сервисная выручка (доставка) за неделю. Волна 4: отдельное поле. */
  deliveryRevenueRub: number
  /** food + delivery — общий объём недели для озвучки (НЕ для маржи). */
  totalRevenueRub: number
  materialCostRub: number
  daysWithoutMenu: number
  /** Кол-во заказов недели — AI сам выведет средний чек если нужно. */
  ordersCount: number
  /** Топ-клиенты недели по объёму. */
  topClients: ClientOrderAggregate[]
  /**
   * 7.16.C: пиковый день недели по объёму. Перенесено из удалённого
   * friday-week-digest, чтобы AI мог упомянуть «лучший день» в пятничном посте.
   */
  peakDay: { date: Date; portions: number } | null
  /**
   * 7.16.C: клиенты, чья первая в истории отгрузка пришлась на эту неделю.
   * Перенесено из friday-week-digest — даёт AI повод поприветствовать новеньких.
   */
  newClients: ClientOrderAggregate[]
  events: BorisEventLog[]
  tones: ToneSummary
  /** Сравнение с прошлой неделей. */
  prevWeekPortionsTotal: number
  prevWeekRevenueRub: number
}

/**
 * Контекст одного события для каналов LIVE и ALERT.
 *
 * LIVE = «положительное» событие (спасибо, рекорд, первая отгрузка, утверждено меню).
 * ALERT = «экстренное» событие (urgent + доставка <4ч).
 */
export interface EventContext {
  event: BorisEventLog
  /** Опциональный сопутствующий день — даёт AI краткий контекст «что вокруг». */
  day?: DayContext
}

/**
 * Стандартный ответ AI-formatter'а.
 *
 * shouldSend=false означает что Боря решил молчать — это валидный исход
 * (молчание лучше шума). В BorisBriefing записываем с пометкой, чтобы
 * в /boris UI было видно «было событие, Боря решил не озвучивать».
 */
export interface TeamPostResult {
  shouldSend: boolean
  text: string | null
  /** Что положить в BorisBriefing.contextData (для дебага и UI). */
  briefingPayload: Record<string, unknown>
  metrics: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
    costUsd: number
  }
}
