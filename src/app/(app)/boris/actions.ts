'use server'

/**
 * Server actions для таба «Команда» страницы /boris (Спринт 7.16.C ЭТАП 2 / C5).
 *
 * Три manual-trigger'а — все только ADMIN_PRO:
 *  1. triggerTeamEveningDigest — вызывает inner-handler из cron-роута
 *     /api/cron/boris-team-evening-digest с принудительным force=true.
 *  2. triggerTeamFriday        — вызывает inner-handler из cron-роута
 *     /api/cron/boris-team-friday с принудительным force=true.
 *  3. triggerTestAlert         — создаёт fake BorisEventLog с eventType=URGENT_NEAR_DELIVERY
 *                                и вызывает emitAlertPost(event). РЕАЛЬНО шлёт в групповой чат.
 *
 * Hotfix 7.16.C.1 (БАГ 1): раньше action'ы делали HTTP-fetch на собственный cron-роут
 * с Authorization: Bearer ${CRON_SECRET}. На Vercel этот вызов уходил во внешнюю сеть
 * и стабильно ловил 401 (по разным причинам — либо CRON_SECRET не пробрасывался в
 * runtime server-component-fetch, либо edge/region mismatch, либо просто не тот URL).
 * Симметричный паттерн 7.16.B (test-morning, test-self-analysis) НЕ делал fetch —
 * он жил в отдельном admin-route /api/admin/boris/test-* с requireRole внутри.
 *
 * Решение: cron-route'ы теперь экспортируют свой inner-handler. Server action
 * вызывает его напрямую в одном процессе. Auth обеспечивается через
 * requireRole(['ADMIN_PRO']) в самом action — Bearer-токен не нужен,
 * HTTP-кругобежки не происходит, withCronHeartbeat-обёртка пропускается
 * намеренно (heartbeat — только для cron-runner'а Vercel).
 */

import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { emitAlertPost } from '@/lib/boris/team-channels'
import {
  runTeamEveningDigest,
  runTeamFridayDigest,
} from '@/lib/boris/team-channels/cron-handlers'

type ActionResult<T = void> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string }

/**
 * Конструирует синтетический Request к cron-эндпоинту с force=true.
 * URL служит ТОЛЬКО для парсинга searchParams внутри handler'а — за пределы
 * текущего процесса не уходит. Хост произвольный (handler читает только pathname/search).
 */
function buildSyntheticCronRequest(path: string): Request {
  const url = `http://internal.local${path}?force=true`
  return new Request(url, { method: 'GET' })
}

/**
 * Безопасно извлекает JSON-тело из ответа handler'а. Cron-handler'ы всегда
 * возвращают NextResponse.json(...), но clone+catch — на случай рефакторинга.
 */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.clone().json()) as Record<string, unknown>
  } catch {
    return null
  }
}

// ============================================================
// Actions
// ============================================================

export async function triggerTeamEveningDigest(): Promise<
  ActionResult<{ briefingId?: string; action?: string }>
> {
  await requireRole(['ADMIN_PRO'])

  let response: Response
  try {
    response = await runTeamEveningDigest(buildSyntheticCronRequest('/api/cron/boris-team-evening-digest'))
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const body = (await readJson(response)) ?? {}
  if (!response.ok || body.ok === false) {
    const errMsg =
      'error' in body ? String(body.error ?? `HTTP ${response.status}`) : `HTTP ${response.status}`
    return { ok: false, error: errMsg }
  }

  const briefingId = typeof body.briefingId === 'string' ? body.briefingId : undefined
  const skipped = typeof body.skipped === 'string' ? body.skipped : undefined
  const actionStr =
    typeof body.action === 'string' ? body.action : skipped ? `SKIPPED:${skipped}` : 'OK'
  const sentSuffix = body.sentToTg === undefined ? '' : `, sentToTg=${String(body.sentToTg)}`
  return {
    ok: true,
    data: { briefingId, action: actionStr },
    message: briefingId
      ? `Создан briefing ${briefingId}, action=${actionStr}${sentSuffix}`
      : `Cron отработал: action=${actionStr}${sentSuffix}`,
  }
}

export async function triggerTeamFriday(): Promise<ActionResult<{ briefingId?: string }>> {
  await requireRole(['ADMIN_PRO'])

  let response: Response
  try {
    response = await runTeamFridayDigest(buildSyntheticCronRequest('/api/cron/boris-team-friday'))
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const body = (await readJson(response)) ?? {}
  if (!response.ok || body.ok === false) {
    const errMsg =
      'error' in body ? String(body.error ?? `HTTP ${response.status}`) : `HTTP ${response.status}`
    return { ok: false, error: errMsg }
  }

  const briefingId = typeof body.briefingId === 'string' ? body.briefingId : undefined
  const skipped = typeof body.skipped === 'string' ? body.skipped : undefined
  const actionStr =
    typeof body.action === 'string' ? body.action : skipped ? `SKIPPED:${skipped}` : 'OK'
  const sentSuffix = body.sentToTg === undefined ? '' : `, sentToTg=${String(body.sentToTg)}`
  return {
    ok: true,
    data: { briefingId },
    message: briefingId
      ? `Создан friday-briefing ${briefingId}, action=${actionStr}${sentSuffix}`
      : `Cron отработал: action=${actionStr}${sentSuffix}`,
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
