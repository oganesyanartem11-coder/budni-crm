import Anthropic from '@anthropic-ai/sdk'

/**
 * Запускает primary; при OverloadedError / InternalServerError / 5xx
 * пробует fallback. Любая другая ошибка пробрасывается без повтора —
 * 400/401/404 повтор не спасёт.
 *
 * Применяется только к дорогим Opus-вызовам (parseMenuSchedule,
 * generateRecipes). Haiku-вызовы (parseClientResponse, generateDraftReply)
 * НЕ оборачиваются: они частые, цена ошибки мала, проще пропустить вызов.
 */
export async function callWithFallback<T>(
  primary: () => Promise<T>,
  fallback: (() => Promise<T>) | null,
  contextLabel: string
): Promise<T> {
  try {
    return await primary()
  } catch (err) {
    // 500 (InternalServerError) и 529 (Overloaded) идут как APIError со status>=500.
    // SDK 0.94 не выделяет 529 в отдельный класс — фильтруем по числовому статусу.
    const isRetryable =
      err instanceof Anthropic.APIError && err.status !== undefined && err.status >= 500

    if (!isRetryable) throw err
    if (fallback === null) {
      console.warn(
        `[ai-fallback] ${contextLabel}: primary failed (${describeError(err)}), no fallback configured — rethrowing`
      )
      throw err
    }

    console.warn(
      `[ai-fallback] ${contextLabel}: primary failed (${describeError(err)}), retrying with fallback model`
    )
    try {
      const result = await fallback()
      console.log(`[ai-fallback] ${contextLabel}: fallback succeeded`)
      return result
    } catch (fallbackErr) {
      console.error(
        `[ai-fallback] ${contextLabel}: fallback also failed (${describeError(fallbackErr)})`
      )
      throw fallbackErr
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    return `${err.constructor.name}${err.status ? ` ${err.status}` : ''}`
  }
  return err instanceof Error ? err.message : String(err)
}
