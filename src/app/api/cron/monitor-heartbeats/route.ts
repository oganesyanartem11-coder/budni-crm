import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import {
  CRON_JOBS,
  CRON_HEARTBEAT_ACTION,
  CRON_ENTITY_TYPE,
} from '@/lib/cron/job-registry'
import { notifyAllManagersDirect } from '@/lib/telegram/notify'

export const dynamic = 'force-dynamic'

/**
 * Sprint 7.7.C.2 — monitor cron heartbeats.
 *
 * Раз в день в 22:00 МСК (= 19:00 UTC) читает последний CRON_HEARTBEAT для
 * каждого job из CRON_JOBS (кроме самого себя). Если ageHours > maxAgeHours,
 * либо последний запуск пометил ok:false, либо записи нет вовсе — собирает
 * алерт и шлёт всем активным менеджерам через notifyAllManagersDirect.
 */
async function handler(_request: Request) {
  const now = Date.now()

  const checks = await Promise.all(
    CRON_JOBS.filter((j) => j.jobName !== 'monitor-heartbeats').map(async (job) => {
      const last = await prisma.activityLog.findFirst({
        where: {
          action: CRON_HEARTBEAT_ACTION,
          entityType: CRON_ENTITY_TYPE,
          entityId: job.jobName,
        },
        select: { createdAt: true, payload: true },
        orderBy: { createdAt: 'desc' },
      })

      if (!last) {
        return {
          jobName: job.jobName,
          description: job.description,
          status: 'never_ran' as const,
          ageHours: null,
          maxAgeHours: job.maxAgeHours,
          lastPayload: null,
        }
      }

      const ageHours = (now - last.createdAt.getTime()) / (3600 * 1000)
      const isStale = ageHours > job.maxAgeHours
      const payloadOk = (last.payload as { ok?: boolean } | null)?.ok !== false

      return {
        jobName: job.jobName,
        description: job.description,
        status: isStale ? ('stale' as const) : payloadOk ? ('ok' as const) : ('last_failed' as const),
        ageHours: Math.round(ageHours * 10) / 10,
        maxAgeHours: job.maxAgeHours,
        lastPayload: last.payload,
      }
    })
  )

  const stale = checks.filter((c) => c.status === 'stale')
  const neverRan = checks.filter((c) => c.status === 'never_ran')
  const lastFailed = checks.filter((c) => c.status === 'last_failed')
  const okCount = checks.filter((c) => c.status === 'ok').length

  const hasIssues = stale.length > 0 || neverRan.length > 0 || lastFailed.length > 0

  if (hasIssues) {
    const lines: string[] = ['🚨 <b>Cron monitor: есть проблемы</b>', '']

    if (stale.length > 0) {
      lines.push('⏰ <b>Просрочены (нет heartbeat больше maxAge):</b>')
      for (const s of stale) {
        lines.push(`• ${s.description} — ${s.ageHours}ч назад (max ${s.maxAgeHours}ч)`)
      }
      lines.push('')
    }

    if (lastFailed.length > 0) {
      lines.push('❌ <b>Последний запуск завершился ошибкой:</b>')
      for (const f of lastFailed) {
        const err = (f.lastPayload as { error?: string } | null)?.error ?? 'unknown'
        lines.push(`• ${f.description} — ${err}`)
      }
      lines.push('')
    }

    if (neverRan.length > 0) {
      lines.push('❓ <b>Ни разу не запускались (зарегистрированы недавно):</b>')
      for (const n of neverRan) {
        lines.push(`• ${n.description}`)
      }
      lines.push('')
    }

    lines.push(`✅ Работают нормально: ${okCount} из ${checks.length}`)

    const text = lines.join('\n').trim()
    const sendResult = await notifyAllManagersDirect(text, { parseMode: 'HTML' })

    return NextResponse.json({
      ok: true,
      issues: { stale: stale.length, lastFailed: lastFailed.length, neverRan: neverRan.length, okCount },
      alertSent: sendResult,
    })
  }

  return NextResponse.json({
    ok: true,
    issues: null,
    okCount,
    totalChecks: checks.length,
  })
}

export const GET = withCronHeartbeat('monitor-heartbeats', handler)
