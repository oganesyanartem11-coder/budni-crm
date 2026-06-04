import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { LoginForm } from './login-form'
import { Logo } from '@/components/layout/logo'
import { getGreeting } from '@/lib/utils/greeting'
import { tryGetCurrentUser } from '@/lib/auth/current-user'
import { getHomeForRole } from '@/lib/auth/roles'
import { SESSION_COOKIE_NAME } from '@/lib/auth/session'

// force-dynamic: getGreeting() читает текущий час; при статическом SSG
// приветствие застывало бы навсегда. Дёшево (страница без БД-запросов).
export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  // P7: proxy больше НЕ редиректит /login→/dashboard (это замыкало петлю при
  // revoked-сессии с живой JWT-cookie), поэтому /login разбирается сам:
  //   - cookie есть + сессия в БД живая  → уводим на home роли (как раньше proxy);
  //   - cookie есть, но сессия невалидна → /api/auth/clear-session стирает её
  //     (мутировать cookie в рендере Server Component Next 16 запрещает) и
  //     возвращает сюда уже без cookie → ниже отрендерится форма;
  //   - cookie нет                       → сразу форма.
  const cookieStore = await cookies()
  if (cookieStore.has(SESSION_COOKIE_NAME)) {
    const user = await tryGetCurrentUser()
    if (user) {
      redirect(getHomeForRole(user.role))
    }
    redirect('/api/auth/clear-session')
  }

  const greeting = getGreeting()
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 bg-bg">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex justify-center">
          <Logo size="lg" href={undefined} />
        </div>

        <div className="rounded-3xl bg-surface p-8 border border-border" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="space-y-1 mb-6 text-center">
            <h1 className="text-2xl font-bold tracking-tight">{greeting}</h1>
            <p className="text-sm text-fg-muted">Введите ваш PIN-код</p>
          </div>

          <LoginForm />
        </div>

        <p className="text-xs text-center text-fg-subtle">
          CRM-система для сотрудников «Будни»
        </p>
      </div>
    </main>
  )
}
