import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { trackError } from '@/lib/errors/tracker'
import { ACTIVE_STATUSES } from '@/lib/sales/labels'
import { notifyTaskDue } from '@/lib/sales/notify'

/**
 * Sprint 8.0 «Продажи»: пуш-напоминания по задачам воронки.
 *
 * Каждые 10 минут с 09:00 до 21:59 МСК (vercel.json `*\/10 6-18 * * *` UTC):
 * берём открытые задачи с наступившим сроком (dueAt ≤ now), по которым ещё не
 * напоминали (notifiedAt null), у активных неархивных заявок, и шлём пуш
 * исполнителю (фолбэк — всем ADMIN_PRO) с кнопками [✅ Сделано] [⏰ +1 день].
 *
 * Анти-дубль: атомарный claim `notifiedAt: null → now` до отправки — второй
 * инстанс/ретрай (withDbRetry перезапускает весь handler) задачу не заберёт.
 * Если никому не доставлено — claim откатываем, чтобы не потерять напоминание
 * молча: cron повторит через 10 минут, а в ErrorLog уйдёт warn.
 * Задачи, пришедшие ночью, напомнятся в 09:00 МСК со строкой «просрочено на …».
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_NAME = 'sales-reminders'
const BATCH_SIZE = 50
/** Запас до maxDuration: остаток подберёт следующий запуск (задачи не заклеймлены). */
const TIME_BUDGET_MS = 45_000

async function releaseClaim(taskId: string, claimedAt: Date): Promise<void> {
  try {
    await prisma.salesTask.updateMany({
      where: { id: taskId, notifiedAt: claimedAt },
      data: { notifiedAt: null },
    })
  } catch (error) {
    // Откат не прошёл — напоминание останется «отправленным», хотя не ушло.
    await trackError({
      error,
      level: 'error',
      extra: { jobName: JOB_NAME, taskId, reason: 'release_claim_failed' },
    })
  }
}

export async function handler(_request: Request): Promise<NextResponse> {
  const startedAt = Date.now()
  const now = new Date()

  const dueTasks = await prisma.salesTask.findMany({
    where: {
      doneAt: null,
      notifiedAt: null,
      dueAt: { lte: now },
      lead: { archivedAt: null, pipelineStatus: { in: ACTIVE_STATUSES } },
    },
    orderBy: { dueAt: 'asc' },
    take: BATCH_SIZE,
    select: {
      id: true,
      leadId: true,
      type: true,
      title: true,
      note: true,
      dueAt: true,
      assigneeId: true,
      lead: { select: { id: true, company: true, name: true, phone: true } },
    },
  })

  let sent = 0
  let skipped = 0
  let failed = 0

  for (const task of dueTasks) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break

    const claim = await prisma.salesTask.updateMany({
      where: { id: task.id, notifiedAt: null, doneAt: null },
      data: { notifiedAt: now },
    })
    if (claim.count === 0) continue // забрал другой инстанс / задачу успели закрыть

    const result = await notifyTaskDue(task, task.lead, now)
    if (result.delivered) {
      sent += 1
      continue
    }

    await releaseClaim(task.id, now)
    if (result.skipped) skipped += 1
    else failed += 1

    const reason = result.skipped ? 'no_recipients' : (result.error ?? 'telegram_error')
    await trackError({
      // Сообщение постоянное — ErrorLog дедуплицирует по fingerprint, без спама раз в 10 минут.
      error: new Error('sales-reminders: напоминание по задаче никому не доставлено'),
      level: 'warn',
      extra: { jobName: JOB_NAME, taskId: task.id, reason },
    })
  }

  return NextResponse.json({ ok: true, sent, skipped, failed })
}

export const GET = withCronHeartbeat(JOB_NAME, handler)
