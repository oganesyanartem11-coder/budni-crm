import { Logo } from '@/components/layout/logo'
import { TopNav } from '@/components/layout/top-nav'
import { LeftRail } from '@/components/layout/left-rail'
import { MobileTabbar } from '@/components/layout/mobile-tabbar'
import { LogoutButton } from '@/components/layout/logout-button'
import { getCurrentUser } from '@/lib/auth/current-user'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await getCurrentUser()
  const initials = user.name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className="min-h-screen bg-bg flex">
      <LeftRail />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 bg-bg/80 backdrop-blur-md border-b border-border">
          <div className="flex items-center gap-6 px-4 md:px-8 py-4">
            <Logo size="md" />
            <div className="flex-1 hidden md:block">
              <TopNav role={user.role} />
            </div>
            <div className="md:hidden flex items-center gap-2 ml-auto">
              <button
                type="button"
                aria-label="Поиск"
                className="w-9 h-9 rounded-full bg-surface-2 flex items-center justify-center"
              >
                <SearchIcon />
              </button>
              <div
                title={user.name}
                className="w-9 h-9 rounded-full bg-accent text-accent-fg flex items-center justify-center text-xs font-semibold"
              >
                {initials}
              </div>
              <LogoutButton className="md:hidden" />
            </div>
            <div className="hidden md:flex items-center gap-3">
              <div
                title={user.name}
                className="w-9 h-9 rounded-full bg-accent text-accent-fg flex items-center justify-center text-xs font-semibold"
              >
                {initials}
              </div>
              <span className="text-sm font-medium text-fg">{user.name}</span>
            </div>
          </div>
          <div className="md:hidden px-4 pb-3 -mt-1">
            <TopNav role={user.role} />
          </div>
        </header>

        <main className="flex-1 px-4 md:px-8 py-6 md:py-10 pb-24 md:pb-10">
          <div className="mx-auto w-full max-w-[var(--container-page)]">
            {children}
          </div>
        </main>
      </div>

      <MobileTabbar role={user.role} />
    </div>
  )
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}
