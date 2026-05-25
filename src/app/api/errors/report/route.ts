/**
 * 7.12: эндпоинт для репорта клиентских ошибок (вызывается из global-error.tsx).
 *
 * Rate-limit 10/мин на IP, in-memory Map'ом (per-instance — для serverless это
 * OK: лимит мягкий, на cold start он сбрасывается; цель — спам-защита, не SLA).
 */

import { trackError } from '@/lib/errors/tracker'

export const runtime = 'nodejs'

const reportRateLimit = new Map<string, { count: number; windowStart: number }>()

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const w = reportRateLimit.get(ip)
  if (!w || now - w.windowStart > 60_000) {
    reportRateLimit.set(ip, { count: 1, windowStart: now })
    return true
  }
  if (w.count >= 10) return false
  w.count++
  return true
}

export async function POST(req: Request): Promise<Response> {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    if (!checkRateLimit(ip)) {
      return Response.json({ ok: false, error: 'rate_limited' }, { status: 429 })
    }

    let body: unknown = null
    try {
      body = await req.json()
    } catch {
      return Response.json({ ok: false, error: 'bad_json' }, { status: 400 })
    }
    const b = body as Record<string, unknown> | null

    const message = typeof b?.message === 'string' ? b.message : 'Unknown client error'
    const stack = typeof b?.stack === 'string' ? b.stack.slice(0, 4000) : undefined
    const url = typeof b?.url === 'string' ? b.url : undefined
    const digest = typeof b?.digest === 'string' ? b.digest : undefined

    // Собираем синтетический Error чтобы tracker мог нормализовать stack/message.
    const syntheticError = new Error(message)
    if (stack) syntheticError.stack = stack

    await trackError({
      error: syntheticError,
      request: { url },
      level: 'error',
      extra: { source: 'client', digest, ip },
    })
    return Response.json({ ok: true })
  } catch {
    return Response.json({ ok: false }, { status: 500 })
  }
}
