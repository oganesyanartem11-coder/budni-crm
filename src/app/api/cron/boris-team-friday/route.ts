/**
 * Cron-эндпоинт пятничного недельного итога в группу (Командный Боря, канал FRIDAY).
 *
 * Расписание (vercel.json): Пт 16:00 UTC (19:00 МСК).
 * Cron срабатывает в пятницу-вечер; buildWeekContext возьмёт текущую финансовую
 * неделю (Сб-Пт), оканчивающуюся сегодня.
 *
 * Логика вынесена в @/lib/boris/team-channels/cron-handlers (runTeamFridayDigest),
 * чтобы её можно было звать и из cron'а (через withCronHeartbeat + Bearer CRON_SECRET),
 * и напрямую из server actions /boris (manual-trigger «Прогнать Пятницу»),
 * где auth обеспечивается через requireRole(['ADMIN_PRO']). См. 7.16.C.1 hotfix БАГ 1.
 *
 * ?force=true и ?dryRun=true — для ручных запусков и тестов.
 *
 * Спринт 7.16.C, ЭТАП 2.
 */

import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import {
  FRIDAY_JOB_LABEL,
  runTeamFridayDigest,
} from '@/lib/boris/team-channels/cron-handlers'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withCronHeartbeat(FRIDAY_JOB_LABEL, runTeamFridayDigest)
