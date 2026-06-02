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

import type { NextResponse } from 'next/server'

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
 * Общая обвязка для cron-handler'ов: вызывает handler с синтетическим
 * Request, аккуратно парсит JSON-ответ и нормализует поля briefingId /
 * action / skipped / sentToTg / error. Используется ниже в
 * triggerTeamEveningDigest и triggerTeamFriday — обе обёртки превращают
 * результат в ActionResult со своими специфичными toast-сообщениями.
 *
 * Любой throw из handler'а ловится и возвращается как { ok: false }.
 * Случай 200 OK + body.ok === false тоже трактуется как ошибка.
 */
async function runViaSynthetic(
  handler: (req: Request) => Promise<NextResponse>,
  path: string,
): Promise<{
  ok: boolean
  briefingId?: string
  action?: string
  skipped?: string
  sentToTg?: unknown
  error?: string
}> {
  try {
    const response = await handler(buildSyntheticCronRequest(path))
    const body = (await response.clone().json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok || body.ok === false) {
      const error =
        typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
      return { ok: false, error }
    }
    return {
      ok: true,
      briefingId: typeof body.briefingId === 'string' ? body.briefingId : undefined,
      action: typeof body.action === 'string' ? body.action : undefined,
      skipped: typeof body.skipped === 'string' ? body.skipped : undefined,
      sentToTg: 'sentToTg' in body ? body.sentToTg : undefined,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ============================================================
// Actions
// ============================================================

export async function triggerTeamEveningDigest(): Promise<
  ActionResult<{ briefingId?: string; action?: string }>
> {
  await requireRole(['ADMIN_PRO'])

  const result = await runViaSynthetic(runTeamEveningDigest, '/api/cron/boris-team-evening-digest')
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Неизвестная ошибка' }
  }

  const actionStr = result.action ?? (result.skipped ? `SKIPPED:${result.skipped}` : 'OK')
  const sentSuffix = result.sentToTg === undefined ? '' : `, sentToTg=${String(result.sentToTg)}`
  return {
    ok: true,
    data: { briefingId: result.briefingId, action: actionStr },
    message: result.briefingId
      ? `Создан briefing ${result.briefingId}, action=${actionStr}${sentSuffix}`
      : `Cron отработал: action=${actionStr}${sentSuffix}`,
  }
}

export async function triggerTeamFriday(): Promise<ActionResult<{ briefingId?: string }>> {
  await requireRole(['ADMIN_PRO'])

  const result = await runViaSynthetic(runTeamFridayDigest, '/api/cron/boris-team-friday')
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Неизвестная ошибка' }
  }

  const actionStr = result.action ?? (result.skipped ? `SKIPPED:${result.skipped}` : 'OK')
  const sentSuffix = result.sentToTg === undefined ? '' : `, sentToTg=${String(result.sentToTg)}`
  return {
    ok: true,
    data: { briefingId: result.briefingId },
    message: result.briefingId
      ? `Создан friday-briefing ${result.briefingId}, action=${actionStr}${sentSuffix}`
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

export async function triggerGenerateFixedOrders(): Promise<ActionResult<{ created: number }>> {
  const user = await requireRole(['ADMIN_PRO'])

  try {
    const { generateFixedOrdersForRange } = await import('@/lib/orders/generate-orders')
    const { getMskCalendarDayUtc } = await import('@/lib/utils/msk-window')

    const tomorrow = getMskCalendarDayUtc(new Date(), 1)
    const stats = await generateFixedOrdersForRange(tomorrow, 7, {
      triggeredByUserId: user.id,
    })

    return {
      ok: true,
      data: { created: stats.created },
      message: `Создано ${stats.created} заказов на 7 дней вперёд`,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
