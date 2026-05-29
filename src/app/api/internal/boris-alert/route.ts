import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { notifyAllAdminProDirect, escapeHtml } from '@/lib/telegram/notify'

export const dynamic = 'force-dynamic'

const HEALTH_ALERT_ACTION = 'HEALTH_ALERT_SENT'
const DEDUP_WINDOW_HOURS = 24

type AlertKind = 'failure' | 'recovery'

interface AlertBody {
  kind: AlertKind
  summary: string
  detail?: string
  runUrl?: string
}

function isValidBody(body: unknown): body is AlertBody {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  if (b.kind !== 'failure' && b.kind !== 'recovery') return false
  if (typeof b.summary !== 'string' || b.summary.length === 0) return false
  if (b.detail !== undefined && typeof b.detail !== 'string') return false
  if (b.runUrl !== undefined && typeof b.runUrl !== 'string') return false
  return true
}

function buildMessage(body: AlertBody): string {
  const summary = escapeHtml(body.summary)
  const detail = body.detail ? escapeHtml(body.detail) : ''
  const runUrl = body.runUrl ? escapeHtml(body.runUrl) : ''

  if (body.kind === 'failure') {
    let msg = `🚨 <b>${summary}</b>. Проверь — что-то отвалилось.`
    if (detail) msg += `\n\n${detail}`
    if (runUrl) msg += `\n\nПодробности: ${runUrl}`
    return msg
  }
  // recovery
  return `✅ <b>${summary}</b> — снова в строю.`
}

async function findRecentAlert(summary: string, kind: AlertKind): Promise<boolean> {
  const since = new Date(Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000)
  const rows = await prisma.activityLog.findMany({
    where: {
      action: HEALTH_ALERT_ACTION,
      createdAt: { gt: since },
    },
    select: { payload: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return rows.some((r) => {
    const p = r.payload as { kind?: unknown; summary?: unknown } | null
    return p?.summary === summary && p?.kind === kind
  })
}

export async function POST(request: Request) {
  const expectedSecret = process.env.HEALTH_CHECK_SECRET
  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  if (!isValidBody(body)) {
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 })
  }

  // Дедуп: для failure пропускаем повтор того же summary за 24ч.
  // Для recovery шлём только если в окне был failure с тем же summary.
  if (body.kind === 'failure') {
    const alreadySent = await findRecentAlert(body.summary, 'failure')
    if (alreadySent) {
      return NextResponse.json({ ok: true, skipped: 'deduped' })
    }
  } else {
    const hadFailure = await findRecentAlert(body.summary, 'failure')
    if (!hadFailure) {
      return NextResponse.json({ ok: true, skipped: 'no_prior_failure' })
    }
  }

  const text = buildMessage(body)
  const result = await notifyAllAdminProDirect(text, { parseMode: 'HTML' })

  if (result.sentTo === 0) {
    console.error(
      `[boris-alert] LOST: kind=${body.kind} summary="${body.summary}" no ADMIN_PRO recipients (skipped=${result.skippedNoTelegram} failed=${result.failed})`,
    )
    await prisma.activityLog.create({
      data: {
        userId: null,
        userRole: 'ADMIN',
        action: HEALTH_ALERT_ACTION,
        entityType: 'HealthAlert',
        entityId: body.kind,
        payload: { kind: body.kind, summary: body.summary, sentTo: 0 },
      },
    })
    return NextResponse.json({ ok: true, skipped: 'no_recipients' })
  }

  await prisma.activityLog.create({
    data: {
      userId: null,
      userRole: 'ADMIN',
      action: HEALTH_ALERT_ACTION,
      entityType: 'HealthAlert',
      entityId: body.kind,
      payload: { kind: body.kind, summary: body.summary, sentTo: result.sentTo },
    },
  })

  return NextResponse.json({ ok: true, sentTo: result.sentTo })
}
