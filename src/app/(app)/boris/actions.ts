'use server'

/**
 * Server actions для таба «Команда» страницы /boris (Спринт 7.16.C ЭТАП 2 / C5).
 *
 * Три manual-trigger'а — все только ADMIN_PRO:
 *  1. triggerTeamEveningDigest — дёргает /api/cron/boris-team-evening-digest?force=true
 *  2. triggerTeamFriday        — дёргает /api/cron/boris-team-friday?force=true
 *  3. triggerTestAlert         — создаёт fake BorisEventLog с eventType=URGENT_NEAR_DELIVERY
 *                                и вызывает emitAlertPost(event). РЕАЛЬНО шлёт в групповой чат.
 *
 * Подход: HTTP-вызов собственных cron-эндпоинтов с заголовком
 * `Authorization: Bearer ${CRON_SECRET}`. Прямой импорт handler'а невозможен —
 * handler внутри cron-route.ts не экспортирован (это inner-функция withCronHeartbeat),
 * а boris-team-friday/route.ts на момент написания пуст (его создаёт Subagent B).
 *
 * Base URL: пробуем VERCEL_URL (production), затем NEXT_PUBLIC_APP_URL,
 * затем хардкод-fallback на budni-crm.vercel.app — это же значение
 * DEFAULT_APP_BASE_URL из settings/users/actions.ts. На локалке без env,
 * fetch уйдёт на prod — это намеренно (manual-trigger всегда бьёт по продакшну).
 */

import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { emitAlertPost } from '@/lib/boris/team-channels'

type ActionResult<T = void> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string }

const DEFAULT_APP_BASE_URL = 'https://budni-crm.vercel.app'

function getBaseUrl(): string {
  const fromVercel = process.env.VERCEL_URL?.trim()
  if (fromVercel) {
    return fromVercel.startsWith('http') ? fromVercel : `https://${fromVercel}`
  }
  const fromPublic = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (fromPublic) return fromPublic.replace(/\/$/, '')
  return DEFAULT_APP_BASE_URL
}

async function fireCronInternally(
  path: string,
): Promise<{ ok: boolean; body: unknown; error?: string }> {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return { ok: false, body: null, error: 'CRON_SECRET not configured' }
  }
  const baseUrl = getBaseUrl()
  const url = `${baseUrl}${path}${path.includes('?') ? '&' : '?'}force=true`

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${secret}` },
      cache: 'no-store',
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      const errMsg =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error?: unknown }).error ?? `HTTP ${res.status}`)
          : `HTTP ${res.status}`
      return { ok: false, body, error: errMsg }
    }
    return { ok: true, body }
  } catch (err) {
    return {
      ok: false,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ============================================================
// Actions
// ============================================================

export async function triggerTeamEveningDigest(): Promise<
  ActionResult<{ briefingId?: string; action?: string }>
> {
  await requireRole(['ADMIN_PRO'])

  const res = await fireCronInternally('/api/cron/boris-team-evening-digest')
  if (!res.ok) {
    return { ok: false, error: res.error ?? 'unknown_error' }
  }
  const body = (res.body ?? {}) as {
    briefingId?: string
    action?: string
    skipped?: string
    sentToTg?: boolean
  }
  const briefingId = body.briefingId
  const action = body.action ?? (body.skipped ? `SKIPPED:${body.skipped}` : 'OK')
  const sentSuffix =
    body.sentToTg === undefined ? '' : `, sentToTg=${String(body.sentToTg)}`
  return {
    ok: true,
    data: { briefingId, action },
    message: briefingId
      ? `Создан briefing ${briefingId}, action=${action}${sentSuffix}`
      : `Cron отработал: action=${action}${sentSuffix}`,
  }
}

export async function triggerTeamFriday(): Promise<ActionResult<{ briefingId?: string }>> {
  await requireRole(['ADMIN_PRO'])

  const res = await fireCronInternally('/api/cron/boris-team-friday')
  if (!res.ok) {
    return { ok: false, error: res.error ?? 'unknown_error' }
  }
  const body = (res.body ?? {}) as {
    briefingId?: string
    action?: string
    skipped?: string
    sentToTg?: boolean
  }
  const briefingId = body.briefingId
  const action = body.action ?? (body.skipped ? `SKIPPED:${body.skipped}` : 'OK')
  const sentSuffix =
    body.sentToTg === undefined ? '' : `, sentToTg=${String(body.sentToTg)}`
  return {
    ok: true,
    data: { briefingId },
    message: briefingId
      ? `Создан friday-briefing ${briefingId}, action=${action}${sentSuffix}`
      : `Cron отработал: action=${action}${sentSuffix}`,
  }
}

export async function triggerTestAlert(): Promise<ActionResult<{ eventId?: string }>> {
  await requireRole(['ADMIN_PRO'])

  try {
    const fakeEvent = await prisma.borisEventLog.create({
      data: {
        eventType: 'URGENT_NEAR_DELIVERY',
        eventDate: new Date(),
        payload: {
          test: true,
          clientName: 'TEST CLIENT',
          messageExcerpt: 'Тестовый алёрт от ADMIN_PRO',
        },
        deduplKey: `alert-test-${Date.now()}`,
      },
    })

    // emitAlertPost никогда не throws (outer try/catch внутри). Дожидаемся —
    // в server action нам важно дать пользователю обратную связь.
    await emitAlertPost(fakeEvent)

    return {
      ok: true,
      data: { eventId: fakeEvent.id },
      message: `Алёрт отправлен в группу. eventId=${fakeEvent.id}`,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
