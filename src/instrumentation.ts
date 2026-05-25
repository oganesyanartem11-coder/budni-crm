/**
 * 7.12: Next 16 file-convention хук для ловли server-side ошибок.
 *
 * Тип Instrumentation.onRequestError (см. node_modules/next/dist/docs/01-app/...
 * /instrumentation.md): (err, request, context) => void | Promise<void>.
 *
 * Используем dynamic import чтобы избежать кругозависимостей при cold start
 * (instrumentation.ts грузится до того, как разрешится дерево модулей).
 */

import type { Instrumentation } from 'next'

export async function register(): Promise<void> {
  // Точка для будущих интеграций (OpenTelemetry, кастомные провайдеры).
  // Сейчас ничего не инициализируем.
}

export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context
) => {
  // Edge runtime не поддерживает node:crypto/prisma — tracker строго Node.
  // Без guard'а Turbopack/webpack тащит tracker.ts в Edge bundle (даже при
  // динамическом import) и сыпет warning'ом про node:crypto.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    const { trackError } = await import('@/lib/errors/tracker')
    await trackError({
      error: err as Error,
      request: { url: request.path, method: request.method },
      extra: {
        routerKind: context.routerKind,
        routePath: context.routePath,
        routeType: context.routeType,
      },
    })
  } catch (trackErr) {
    // Защита от рекурсии — trackError сам никогда не throw, но на всякий.
    console.error('[instrumentation] onRequestError handler failed:', trackErr)
  }
}
