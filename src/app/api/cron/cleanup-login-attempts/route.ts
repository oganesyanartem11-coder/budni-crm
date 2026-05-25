import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'

export const dynamic = 'force-dynamic'

const RETENTION_DAYS = 30

/**
 * 7.9: чистит таблицу LoginAttempt от старых записей. Таблица append-only —
 * каждый login пишет строку. Раз в неделю удаляем старше 30 дней.
 */
async function handler(_request: Request) {
  const threshold = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const result = await prisma.loginAttempt.deleteMany({
    where: { createdAt: { lt: threshold } },
  })
  return NextResponse.json({ ok: true, deleted: result.count, retentionDays: RETENTION_DAYS })
}

export const GET = withCronHeartbeat('cleanup-login-attempts', handler)
