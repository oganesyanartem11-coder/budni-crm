import type { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const DELIVERY_GEO_RAW_RETENTION_DAYS = 60
export const DELIVERY_GEO_PURGE_BATCH_SIZE = 500

export async function handler(
  _request: Request,
  now = new Date(),
): Promise<NextResponse> {
  const cutoff = new Date(
    now.getTime() - DELIVERY_GEO_RAW_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  )
  const eligibleWhere: Prisma.DeliveryGeoAttemptWhereInput = {
    receivedAt: { lt: cutoff },
    purgedAt: null,
    OR: [
      { courierLatitude: { not: null } },
      { courierLongitude: { not: null } },
    ],
  }

  const rows = await prisma.deliveryGeoAttempt.findMany({
    where: eligibleWhere,
    select: { id: true },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    take: DELIVERY_GEO_PURGE_BATCH_SIZE,
  })

  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      purged: 0,
      retentionDays: DELIVERY_GEO_RAW_RETENTION_DAYS,
      batchSize: DELIVERY_GEO_PURGE_BATCH_SIZE,
      hasMore: false,
    })
  }

  const result = await prisma.deliveryGeoAttempt.updateMany({
    where: {
      id: { in: rows.map((row) => row.id) },
      ...eligibleWhere,
    },
    data: {
      courierLatitude: null,
      courierLongitude: null,
      purgedAt: now,
    },
  })

  return NextResponse.json({
    ok: true,
    purged: result.count,
    retentionDays: DELIVERY_GEO_RAW_RETENTION_DAYS,
    batchSize: DELIVERY_GEO_PURGE_BATCH_SIZE,
    hasMore: rows.length === DELIVERY_GEO_PURGE_BATCH_SIZE,
  })
}

export const GET = withCronHeartbeat('cleanup-delivery-geo', handler)
