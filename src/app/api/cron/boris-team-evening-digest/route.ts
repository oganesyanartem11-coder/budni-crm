/**
 * Cron-эндпоинт вечернего итога дня в группу (Командный Боря, канал EVENING).
 *
 * Расписание (vercel.json): Пн-Чт 17:00 UTC (20:00 МСК).
 *
 * Логика вынесена в @/lib/boris/team-channels/cron-handlers (runTeamEveningDigest),
 * чтобы её можно было звать и из cron'а (через withCronHeartbeat + Bearer CRON_SECRET),
 * и напрямую из server actions /boris (manual-trigger «Прогнать Итог дня»),
 * где auth обеспечивается через requireRole(['ADMIN_PRO']). См. 7.16.C.1 hotfix БАГ 1.
 *
 * ?force=true и ?dryRun=true — для ручных запусков и тестов.
 *
 * Спринт 7.16.C, ЭТАП 2.
 */

import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import {
  EVENING_JOB_LABEL,
  runTeamEveningDigest,
} from '@/lib/boris/team-channels/cron-handlers'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withCronHeartbeat(EVENING_JOB_LABEL, runTeamEveningDigest)
