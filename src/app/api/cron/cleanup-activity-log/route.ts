import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'

export const dynamic = 'force-dynamic'

const HEARTBEAT_RETENTION_DAYS = 30
const LOGIN_RETENTION_DAYS = 90
const ERROR_RETENTION_DAYS = 30
const BATCH = 5000

/**
 * 7.12: еженедельная очистка ActivityLog + ErrorLog.
 *  - CRON_HEARTBEAT строки старше 30 дней — мусор для аудита.
 *  - LOGIN_* строки старше 90 дней — security-аудит держим квартал.
 *  - ErrorLog с resolvedAt старше 30 дней — активные ошибки не трогаем.
 *
 * Удаление батчами по 5000 чтобы не блокировать таблицу — нагрузка распределяется
 * на несколько мелких транзакций вместо одной большой.
 */
async function deleteInBatches(
  label: string,
  fn: () => Promise<{ count: number }>,
): Promise<number> {
  let total = 0
  // Защита от бесконечного цикла: максимум 1000 батчей (= 5M строк), достаточно.
  for (let i = 0; i < 1000; i++) {
    const r = await fn()
    if (r.count === 0) break
    total += r.count
    if (r.count < BATCH) break
  }
  console.log(`[cleanup-activity-log] ${label}: deleted ${total}`)
  return total
}

async function handler(_request: Request) {
  const now = Date.now()
  const heartbeatThreshold = new Date(now - HEARTBEAT_RETENTION_DAYS * 86400_000)
  const loginThreshold = new Date(now - LOGIN_RETENTION_DAYS * 86400_000)
  const errorThreshold = new Date(now - ERROR_RETENTION_DAYS * 86400_000)

  const heartbeatsDeleted = await deleteInBatches('heartbeats', async () => {
    const r = await prisma.$executeRawUnsafe(
      `DELETE FROM "ActivityLog" WHERE id IN (
         SELECT id FROM "ActivityLog"
         WHERE action = 'CRON_HEARTBEAT' AND "createdAt" < $1
         LIMIT ${BATCH}
       )`,
      heartbeatThreshold,
    )
    return { count: Number(r) }
  })

  const loginsDeleted = await deleteInBatches('logins', async () => {
    const r = await prisma.$executeRawUnsafe(
      `DELETE FROM "ActivityLog" WHERE id IN (
         SELECT id FROM "ActivityLog"
         WHERE action IN ('LOGIN_SUCCESS','LOGIN_FAILED','LOGIN_RATE_LIMITED','LOGIN_LOCKED_ATTEMPT')
           AND "createdAt" < $1
         LIMIT ${BATCH}
       )`,
      loginThreshold,
    )
    return { count: Number(r) }
  })

  // ErrorLog cleanup — только resolved старше N дней. Активные ошибки не трогаем.
  // Best-effort try/catch: если миграция ErrorLog ещё не применена (например на
  // первом деплое до prisma migrate), не валим весь cron.
  let errorsDeleted = 0
  try {
    const r = await prisma.$executeRawUnsafe(
      `DELETE FROM "ErrorLog" WHERE "resolvedAt" IS NOT NULL AND "resolvedAt" < $1`,
      errorThreshold,
    )
    errorsDeleted = Number(r)
    console.log(`[cleanup-activity-log] errors: deleted ${errorsDeleted}`)
  } catch (e) {
    console.warn('[cleanup-activity-log] ErrorLog cleanup skipped:', (e as Error).message)
  }

  return NextResponse.json({
    ok: true,
    heartbeatsDeleted,
    loginsDeleted,
    errorsDeleted,
    retention: {
      heartbeatDays: HEARTBEAT_RETENTION_DAYS,
      loginDays: LOGIN_RETENTION_DAYS,
      errorDays: ERROR_RETENTION_DAYS,
    },
  })
}

export const GET = withCronHeartbeat('cleanup-activity-log', handler)
