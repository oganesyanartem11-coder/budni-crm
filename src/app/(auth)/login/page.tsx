import { LoginForm } from './login-form'
import { Logo } from '@/components/layout/logo'
import { getGreeting } from '@/lib/utils/greeting'

// force-dynamic: getGreeting() читает текущий час; при статическом SSG
// приветствие застывало бы навсегда. Дёшево (страница без БД-запросов).
export const dynamic = 'force-dynamic'

export default function LoginPage() {
  const greeting = getGreeting()
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 bg-bg">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex justify-center">
          <Logo size="lg" href={undefined} />
        </div>

        <div className="rounded-2xl bg-surface p-8 border border-border" style={{ boxShadow: 'var(--shadow-card)' }}>
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
