import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE_NAME } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'

/**
 * P7: стирает stale-cookie `budni_session` и возвращает на /login.
 *
 * Зачем отдельный route-handler: login-страница — Server Component, а Next 16
 * запрещает мутацию cookie во время рендера Server Component
 * (node_modules/next/dist/docs/.../cookies.md: «.delete only in Server Function
 * or Route Handler»; «Setting cookies is not supported during Server Component
 * rendering»). Поэтому login/page.tsx при cookie-с-невалидной-БД-сессией
 * редиректит сюда, а удаление cookie выполняется здесь, где это разрешено.
 *
 * Маршрут под /api → исключён из proxy-матчера, поэтому доступен без авторизации
 * и не участвует в редирект-логике proxy. Цикла нет: /login (stale) → сюда
 * (cookie стёрта) → /login (cookie уже нет) → рендер формы.
 */
export function GET(request: NextRequest) {
  const res = NextResponse.redirect(new URL('/login', request.url))
  // maxAge:0 + тот же path, что у выданной cookie ('/'), — надёжно гасим её.
  res.cookies.set(SESSION_COOKIE_NAME, '', { path: '/', maxAge: 0 })
  return res
}
