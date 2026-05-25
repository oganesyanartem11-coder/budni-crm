import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { CRON_HEARTBEAT_ACTION, CRON_ENTITY_TYPE } from './job-registry'

export type CronHandler = (request: Request) => Promise<NextResponse>

/**
 * Обёртка cron-эндпоинта: проверка CRON_SECRET + try/catch + heartbeat в ActivityLog.
 *
 * Heartbeat пишется ВСЕГДА (успех или fail) — это даёт monitor'у (C.2) видеть
 * что cron хотя бы запустился. Бизнес-логика внутри handler НЕ должна делать
 * свой auth-check (HOF уже сделал).
 */
export function withCronHeartbeat(jobName: string, handler: CronHandler): CronHandler {
  return async (request: Request) => {
    const startedAt = Date.now()

    const expectedSecret = process.env.CRON_SECRET
    if (!expectedSecret) {
      return NextResponse.json({ ok: false, error: 'CRON_SECRET not configured' }, { status: 500 })
    }
    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${expectedSecret}`) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    let response: NextResponse
    let payload: Record<string, unknown>

    try {
      response = await handler(request)
      // Best-effort вытащить body для heartbeat-payload (не блокируем при ошибке).
      try {
        const cloned = response.clone()
        const body = await cloned.json()
        payload = { ok: body?.ok ?? true, status: response.status, ...body }
      } catch {
        payload = { ok: true, status: response.status }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error(`[cron:${jobName}] failed:`, err)
      payload = { ok: false, error: errorMessage }
      // 7.12: репорт в in-house tracker. Dynamic import — избегаем circular dep
      // (tracker → prisma → ... → cron). void — не блокируем основной поток.
      void import('@/lib/errors/tracker').then((m) =>
        m.trackError({
          error: err,
          extra: { jobName, source: 'cron' },
          level: 'error',
        })
      )
      response = NextResponse.json({ ok: false, error: errorMessage }, { status: 500 })
    }

    const durationMs = Date.now() - startedAt

    // Heartbeat — best-effort, не должен ронять ответ.
    try {
      await prisma.activityLog.create({
        data: {
          userId: null,
          userRole: 'ADMIN',
          action: CRON_HEARTBEAT_ACTION,
          entityType: CRON_ENTITY_TYPE,
          entityId: jobName,
          payload: { ...payload, durationMs },
        },
      })
    } catch (heartbeatErr) {
      console.error(`[cron:${jobName}] heartbeat write failed:`, heartbeatErr)
    }

    return response
  }
}
