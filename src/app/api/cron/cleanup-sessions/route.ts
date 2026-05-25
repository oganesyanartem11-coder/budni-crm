import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'

export const dynamic = 'force-dynamic'

const REVOKED_RETENTION_DAYS = 7

/**
 * 7.10: чистка Session-таблицы. Удаляет:
 *  - expired сессии (expiresAt < now) — JWT уже мёртв сам по себе.
 *  - revoked сессии старше 7 дней — для аудита держим неделю, потом sweep.
 */
async function handler(_request: Request) {
  const now = new Date()
  const sevenDaysAgo = new Date(Date.now() - REVOKED_RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const result = await prisma.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { revokedAt: { lt: sevenDaysAgo } },
      ],
    },
  })

  return NextResponse.json({ ok: true, deleted: result.count, revokedRetentionDays: REVOKED_RETENTION_DAYS })
}

export const GET = withCronHeartbeat('cleanup-sessions', handler)
