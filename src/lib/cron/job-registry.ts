export interface CronJobConfig {
  /** Уникальное имя job — совпадает с path сегментом /api/cron/<jobName>. */
  jobName: string
  /** Cron schedule в UTC из vercel.json — для документации. */
  scheduleUtc: string
  /** Краткое описание для алертов. */
  description: string
  /** Сколько максимум часов между запусками. Если lastHeartbeat старше — алерт. */
  maxAgeHours: number
}

// Источник правды для monitor'а (7.7 C.2) — какие cron'ы ожидаются и как часто.
// 26h = сутки + 2 часа запаса (деплой/congestion); 170h = неделя + 2 часа.
export const CRON_JOBS: CronJobConfig[] = [
  { jobName: 'extend-active-menu',          scheduleUtc: '0 1 * * *',   description: 'Авто-продление APPROVED меню',         maxAgeHours: 26 },
  { jobName: 'generate-fixed-orders',       scheduleUtc: '0 3 * * *',   description: 'Генерация фиксированных заказов',      maxAgeHours: 26 },
  { jobName: 'daily-questions-sameday',     scheduleUtc: '40 4 * * *',  description: 'SameDay-клиенты: утренний пуш-вопрос о количестве порций', maxAgeHours: 26 },
  { jobName: 'daily-questions',             scheduleUtc: '0 8 * * *',   description: 'Утренние вопросы клиентам в MAX',      maxAgeHours: 26 },
  { jobName: 'reminder-and-summary-1',      scheduleUtc: '0 11 * * *',  description: 'Reminder менеджеру #1',                maxAgeHours: 26 },
  { jobName: 'reminder-and-summary-2',      scheduleUtc: '30 12 * * *', description: 'Reminder менеджеру #2',                maxAgeHours: 26 },
  { jobName: 'cutoff-notice',               scheduleUtc: '0 13 * * *',  description: 'Cut-off нотификация клиентам',         maxAgeHours: 26 },
  { jobName: 'production-summary',          scheduleUtc: '5 13 * * *',  description: 'Сводка для шефа в группу',             maxAgeHours: 26 },
  { jobName: 'route-sheet-evening',         scheduleUtc: '10 13 * * *', description: 'Маршрутный лист на завтра в чат-производство (16:10 МСК)', maxAgeHours: 26 },
  { jobName: 'route-sheet-sameday',         scheduleUtc: '50 4 * * *',  description: 'Same-day маршрутный лист на сегодня (07:50 МСК)', maxAgeHours: 26 },
  { jobName: 'check-late-deliveries',       scheduleUtc: '*/10 6-19 * * *', description: 'Поздние доставки — алерт каждые 10 минут (9-22 МСК)', maxAgeHours: 14 },
  { jobName: 'courier-evening-preview',     scheduleUtc: '0 15 * * *',  description: 'Вечерний обзор заказов без курьера на завтра (18:00 МСК)', maxAgeHours: 26 },
  { jobName: 'courier-hour-before-window',  scheduleUtc: '*/30 2-8 * * *', description: 'Заказ без курьера за час до окна доставки (каждые 30 мин)', maxAgeHours: 2 },
  { jobName: 'expire-pending-changes',      scheduleUtc: '*/10 * * * *', description: 'Протухшие запросы клиентов на изменение заказа (каждые 10 мин)', maxAgeHours: 1 },
  { jobName: 'unpriced-ingredients-digest', scheduleUtc: '0 9 * * 1',   description: 'Ингредиенты без цены (понедельник)',   maxAgeHours: 170 },
  { jobName: 'monitor-heartbeats',          scheduleUtc: '0 19 * * *',  description: 'Monitor cron heartbeats (себя не алертит)', maxAgeHours: 26 },
  { jobName: 'cleanup-login-attempts',      scheduleUtc: '0 0 * * 1',   description: 'Очистка LoginAttempt старше 30 дней (понедельник)', maxAgeHours: 170 },
  { jobName: 'cleanup-sessions',            scheduleUtc: '30 0 * * 1',  description: 'Очистка expired/revoked Session (понедельник)',     maxAgeHours: 170 },
  { jobName: 'cleanup-activity-log',        scheduleUtc: '0 1 * * 1',   description: 'Очистка ActivityLog/ErrorLog (понедельник)',        maxAgeHours: 200 },
  { jobName: 'market-check-reminder',       scheduleUtc: '0 7 * * 0',   description: 'Воскресная проверка рынка (овощи)',                 maxAgeHours: 170 },
  { jobName: 'weekly-request-reminder',     scheduleUtc: '0 9 * * 4',   description: 'Недельная заявка — напоминание клиенту (Чт 12:00 МСК)', maxAgeHours: 168 },
  { jobName: 'weekly-missing-alert',        scheduleUtc: '0 12 * * 5',  description: 'Недельная заявка — алёрт менеджеру если нет заявки (Пт 15:00 МСК)', maxAgeHours: 168 },
  { jobName: 'boris-9am-summary',           scheduleUtc: '0 6 * * *',   description: 'Утренняя сводка отгрузок на сегодня в группу (9:00 МСК)', maxAgeHours: 26 },
  { jobName: 'boris-team-evening-digest',   scheduleUtc: '0 17 * * 1-4', description: 'Итог дня в группу (Командный Боря)',                maxAgeHours: 26 },
  { jobName: 'boris-team-friday',           scheduleUtc: '0 16 * * 5',  description: 'Пятничный недельный итог (Командный Боря)',         maxAgeHours: 170 },
]

export const CRON_HEARTBEAT_ACTION = 'CRON_HEARTBEAT'
export const CRON_ENTITY_TYPE = 'Cron'
