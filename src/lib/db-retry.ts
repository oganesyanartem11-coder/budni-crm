/**
 * Retry-обёртка для prisma-операций, падающих на «холодном» Neon.
 *
 * Прод: Neon Frankfurt compute суспендится при простое. Первая prisma-операция
 * после простоя падает с P1001 «Can't reach database server» (cold-start), пока
 * compute поднимается (~секунды). Один ретрай с backoff'ом обычно ловит уже
 * «тёплый» compute.
 *
 * Ретраим ТОЛЬКО транспортные ошибки доступности БД:
 *   - P1001 — Can't reach database server (PrismaClientInitializationError:
 *             код лежит в `.errorCode`; у known-request-ошибок — в `.code`).
 *   - P1002 — database server timed out.
 * Бизнес-ошибки (unique violation P2002, валидация и т.п.) НЕ ретраим — пробрасываем
 * сразу.
 *
 * Backoff экспоненциальный: baseDelay * 2^(attempt-1) + jitter (0..500ms).
 */
export interface WithDbRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  label?: string
}

function isRetryableDbError(err: unknown): boolean {
  const e = err as { code?: unknown; errorCode?: unknown; message?: unknown } | null
  const code = typeof e?.code === 'string' ? e.code : typeof e?.errorCode === 'string' ? e.errorCode : ''
  const message = typeof e?.message === 'string' ? e.message : String(e?.message ?? '')
  const isP1001 = code === 'P1001' || /can't reach database server/i.test(message)
  const isP1002 = code === 'P1002' || /server.*timed out/i.test(message)
  return isP1001 || isP1002
}

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts?: WithDbRetryOptions
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3
  const baseDelayMs = opts?.baseDelayMs ?? 1000
  const label = opts?.label ?? 'db-retry'

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const code = (err as { code?: unknown; errorCode?: unknown })?.code
        ?? (err as { errorCode?: unknown })?.errorCode
        ?? 'unknown'

      // Не-ретраибл (бизнес-ошибка) или исчерпали попытки — пробрасываем.
      if (!isRetryableDbError(err) || attempt === maxAttempts) {
        throw err
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500
      console.warn(
        `[${label}] attempt ${attempt}/${maxAttempts} failed (${String(code)}), retrying in ${Math.round(delayMs)}ms`
      )
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  // Недостижимо (последняя попытка либо вернула, либо бросила), но для типов:
  throw lastError
}
