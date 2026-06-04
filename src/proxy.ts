import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

const SESSION_COOKIE = 'budni_session'

// Маршруты, доступные без авторизации
const PUBLIC_ROUTES = ['/login']

async function verifyToken(token: string): Promise<boolean> {
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET)
    await jwtVerify(token, secret, { algorithms: ['HS256'] })
    return true
  } catch {
    return false
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isPublicRoute = PUBLIC_ROUTES.includes(pathname)
  const token = request.cookies.get(SESSION_COOKIE)?.value
  const isAuthenticated = token ? await verifyToken(token) : false

  // P7: ВСТРЕЧНЫЙ редирект /login→/dashboard УДАЛЁН. Он замыкал петлю:
  // proxy.verifyToken проверяет только подпись JWT (stateless), а getCurrentUser
  // проверяет БД-сессию (revoked/expired/inactive). При живой JWT-cookie с
  // revoked БД-сессией (напр. после changePin, который ревокает все сессии)
  // getCurrentUser слал /dashboard→/login, а proxy слал /login→/dashboard → ∞
  // (ERR_TOO_MANY_REDIRECTS в Safari/Telegram). Теперь /login рендерится
  // свободно и сам разбирается с сессией (см. login/page.tsx).

  // Если не на публичном маршруте и не авторизован — на /login
  if (!isPublicRoute && !isAuthenticated) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // П7: пробрасываем текущий путь как REQUEST-заголовок x-pathname, чтобы
  // Server Component (requireRole) мог реализовать self-loop guard через
  // `await headers()`.
  //
  // Next 16 (проверено по node_modules/next/dist/docs/.../proxy.md): чтобы
  // заголовок был читаем из Server Component, его нужно установить именно как
  // request-заголовок через NextResponse.next({ request: { headers } }).
  // Установка на response.headers отдаёт его клиенту, но НЕ серверным
  // компонентам.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-pathname', pathname)

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })
}

// Применяется ко всем маршрутам кроме статики и API health-check
export const config = {
  matcher: [
    /*
     * Все пути кроме:
     * - api routes (обрабатываются отдельно)
     * - _next/static (статика Next.js)
     * - _next/image (оптимизация изображений)
     * - favicon, *.svg, *.png и т.п.
     * - manifest.json (PWA-манифест должен быть публичным — Bug 7.24-7)
     */
    '/((?!api|_next/static|_next/image|favicon.ico|manifest.json|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
