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
  { jobName: 'daily-questions',             scheduleUtc: '0 8 * * *',   description: 'Утренние вопросы клиентам в MAX',      maxAgeHours: 26 },
  { jobName: 'reminder-and-summary-1',      scheduleUtc: '0 11 * * *',  description: 'Reminder менеджеру #1',                maxAgeHours: 26 },
  { jobName: 'reminder-and-summary-2',      scheduleUtc: '30 12 * * *', description: 'Reminder менеджеру #2',                maxAgeHours: 26 },
  { jobName: 'cutoff-notice',               scheduleUtc: '0 13 * * *',  description: 'Cut-off нотификация клиентам',         maxAgeHours: 26 },
  { jobName: 'production-summary',          scheduleUtc: '5 13 * * *',  description: 'Сводка для шефа в группу',             maxAgeHours: 26 },
  { jobName: 'end-of-day-digest',           scheduleUtc: '0 15 * * *',  description: 'Дневной дайджест в группу',            maxAgeHours: 26 },
  { jobName: 'friday-week-digest',          scheduleUtc: '0 16 * * 5',  description: 'Недельный дайджест (пятница)',         maxAgeHours: 170 },
  { jobName: 'check-late-deliveries',       scheduleUtc: '*/10 6-19 * * *', description: 'Поздние доставки — алерт каждые 10 минут (9-22 МСК)', maxAgeHours: 14 },
  { jobName: 'unpriced-ingredients-digest', scheduleUtc: '0 9 * * 1',   description: 'Ингредиенты без цены (понедельник)',   maxAgeHours: 170 },
  { jobName: 'monitor-heartbeats',          scheduleUtc: '0 19 * * *',  description: 'Monitor cron heartbeats (себя не алертит)', maxAgeHours: 26 },
  { jobName: 'cleanup-login-attempts',      scheduleUtc: '0 0 * * 1',   description: 'Очистка LoginAttempt старше 30 дней (понедельник)', maxAgeHours: 170 },
  { jobName: 'cleanup-sessions',            scheduleUtc: '30 0 * * 1',  description: 'Очистка expired/revoked Session (понедельник)',     maxAgeHours: 170 },
  { jobName: 'cleanup-activity-log',        scheduleUtc: '0 1 * * 1',   description: 'Очистка ActivityLog/ErrorLog (понедельник)',        maxAgeHours: 200 },
]

export const CRON_HEARTBEAT_ACTION = 'CRON_HEARTBEAT'
export const CRON_ENTITY_TYPE = 'Cron'
