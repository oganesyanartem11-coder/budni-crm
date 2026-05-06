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

  // Если на /login и уже авторизован — на дашборд
  if (isPublicRoute && isAuthenticated) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  // Если не на публичном маршруте и не авторизован — на /login
  if (!isPublicRoute && !isAuthenticated) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return NextResponse.next()
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
     */
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
