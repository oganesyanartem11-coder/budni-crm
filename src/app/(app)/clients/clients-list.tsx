'use client'

import { useState, useMemo, useTransition } from 'react'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Search, Users } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatClients } from '@/lib/utils/format'
import { ORDER_TYPE_SHORT, MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { getOnboardingStatus, type ClientForOnboarding } from '@/lib/clients/onboarding'
import { EmptyState } from '@/components/ui/empty-state'
import type { Client, ClientLocation, MealType, OrderType } from '@prisma/client'

type SerializedClient = Omit<Client, never> & {
  locations: Array<Pick<ClientLocation, 'id' | 'name' | 'packaging' | 'tags' | 'isActive'>>
  mealConfigs: Array<{
    id: string
    mealType: MealType
    orderType: OrderType
    fixedPortions: number | null
    pricePerPortion: number
    isActive: boolean
  }>
  maxUsers: Array<{ isActive: boolean }>
  _count: {
    orders: number
    locations: number
    mealConfigs: number
  }
}

type StatusFilter = 'all' | 'incomplete'

interface Props {
  clients: SerializedClient[]
}

export function ClientsList({ clients }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()

  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const statusFilter: StatusFilter =
    searchParams.get('status') === 'incomplete' ? 'incomplete' : 'all'

  function setStatusFilter(value: StatusFilter) {
    const params = new URLSearchParams(searchParams.toString())
    if (value === 'all') {
      params.delete('status')
    } else {
      params.set('status', value)
    }
    startTransition(() => {
      const qs = params.toString()
      router.push(qs ? `${pathname}?${qs}` : pathname)
    })
  }

  const filtered = useMemo(() => {
    return clients.filter((c) => {
      if (!showArchived && !c.isActive) return false

      if (statusFilter === 'incomplete') {
        // Архивных в выборку «в настройке» не пускаем — чек-лист для них
        // бессмыслен. Если showArchived=true и есть архивные — они отсеяны.
        if (!c.isActive) return false
        const status = getOnboardingStatus(c as ClientForOnboarding)
        if (status.isComplete) return false
      }

      if (search) {
        const q = search.toLowerCase()
        const inName = c.name.toLowerCase().includes(q)
        const inContact = (c.contactName ?? '').toLowerCase().includes(q)
        const inLocations = c.locations.some((l) => l.name.toLowerCase().includes(q))
        if (!inName && !inContact && !inLocations) return false
      }
      return true
    })
  }, [clients, search, showArchived, statusFilter])

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-surface border border-border p-4 flex flex-col md:flex-row md:items-center gap-3 shadow-card">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-subtle pointer-events-none" aria-hidden="true" />
          <input
            type="search"
            placeholder="Поиск по названию клиента, контакту, точке"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full min-h-[44px] pl-10 pr-3 py-2.5 rounded-xl bg-surface border border-border text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors [touch-action:manipulation]"
          />
        </div>
        <div className="inline-flex rounded-pill border border-border p-0.5 bg-bg text-xs">
          <button
            type="button"
            onClick={() => setStatusFilter('all')}
            className={cn(
              'min-h-[36px] px-3.5 rounded-pill transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30',
              statusFilter === 'all'
                ? 'bg-brand-green-deep text-white font-medium'
                : 'text-fg-muted hover:text-fg'
            )}
          >
            Все
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('incomplete')}
            className={cn(
              'min-h-[36px] px-3.5 rounded-pill transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30',
              statusFilter === 'incomplete'
                ? 'bg-brand-green-deep text-white font-medium'
                : 'text-fg-muted hover:text-fg'
            )}
          >
            В настройке
          </button>
        </div>
        <label className="flex items-center gap-2.5 min-h-[44px] px-1 text-sm text-fg-muted cursor-pointer select-none [touch-action:manipulation]">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="w-5 h-5 rounded-md border-border text-brand-green-deep accent-brand-green-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30 cursor-pointer"
          />
          Показать архивных
        </label>
      </div>

      {filtered.length === 0 ? (
        search ? (
          <EmptyState
            icon={Search}
            title="Ничего не найдено"
            description={`По запросу «${search}» клиентов нет. Попробуйте изменить условия поиска.`}
          />
        ) : (
          <EmptyState
            icon={Users}
            title="Клиентов пока нет"
            description="Добавьте первого клиента — заведите точки доставки, расписание и цены."
            cta={
              <Link
                href="/clients/new"
                style={{ background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' }}
                className="inline-flex items-center justify-center min-h-[44px] px-5 py-2.5 rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                Добавить клиента
              </Link>
            }
          />
        )
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((c) => (
            <ClientCard key={c.id} client={c} />
          ))}
        </div>
      )}

      {(search.length > 0 || showArchived) && (
        <p className="text-xs text-fg-subtle text-center">
          {formatClients(filtered.length)} из {clients.length}
        </p>
      )}
    </div>
  )
}

function ClientCard({ client }: { client: SerializedClient }) {
  const initials = client.name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  // «На онбординге» — только для активных клиентов, по той же чистой
  // функции, что используется фильтром «В настройке» выше. Новой логики не вводим.
  const isOnboarding =
    client.isActive && !getOnboardingStatus(client as ClientForOnboarding).isComplete

  return (
    <Link
      href={`/clients/${client.id}`}
      className={cn(
        'block rounded-2xl bg-surface border border-border p-5 shadow-card hover:shadow-card-hover transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30 [touch-action:manipulation]',
        !client.isActive && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-3 mb-4">
        <div className="w-12 h-12 rounded-full bg-info-bg text-info-fg flex items-center justify-center font-display font-bold shrink-0">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-display font-bold text-lg text-fg-strong truncate leading-tight">
            {client.name}
          </h3>
          {client.contactName && (
            <p className="text-sm text-fg-muted truncate">
              {client.contactName}
              {client.contactPhone && ` · ${client.contactPhone}`}
            </p>
          )}
        </div>
        {(!client.isActive || isOnboarding) && (
          <div className="flex flex-col items-end gap-1 shrink-0">
            {!client.isActive && (
              <span className="px-2 py-0.5 rounded-full bg-neutral-bg text-neutral-fg text-xs font-bold uppercase tracking-wide">
                Архив
              </span>
            )}
            {isOnboarding && (
              <span className="px-2 py-0.5 rounded-full bg-warning-bg text-warning-fg text-xs whitespace-nowrap">
                На онбординге
              </span>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        <Stat label="Заказов" value={client._count.orders} tone="revenue" />
        <Stat label="Точек" value={client._count.locations} tone="orders" />
        <Stat label="Конфигов" value={client._count.mealConfigs} tone="amount" />
      </div>

      {client.mealConfigs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {client.mealConfigs.slice(0, 3).map((cfg) => (
            <span
              key={cfg.id}
              className="text-xs px-2 py-0.5 rounded-pill bg-surface-2 text-fg-muted"
            >
              {MEAL_TYPE_LABELS[cfg.mealType]} · {ORDER_TYPE_SHORT[cfg.orderType]}
              {cfg.fixedPortions ? ` · ${cfg.fixedPortions}` : ''}
            </span>
          ))}
          {client.mealConfigs.length > 3 && (
            <span className="text-xs text-fg-subtle px-2 py-0.5">
              + ещё {client.mealConfigs.length - 3}
            </span>
          )}
        </div>
      )}
    </Link>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'revenue' | 'orders' | 'amount' }) {
  const toneClasses: Record<typeof tone, { bg: string; ink: string }> = {
    revenue: { bg: 'bg-data-revenue-bg', ink: 'text-data-revenue-ink' },
    orders: { bg: 'bg-data-orders-bg', ink: 'text-data-orders-ink' },
    amount: { bg: 'bg-data-amount-bg', ink: 'text-data-amount-ink' },
  }
  const t = toneClasses[tone]
  return (
    <div className={cn('rounded-lg p-2.5 text-center', t.bg)}>
      <div className="font-display font-extrabold text-fg-strong tabular-nums leading-none">
        {value}
      </div>
      <div className={cn('mt-1 text-[9px] uppercase tracking-wide leading-none', t.ink)}>
        {label}
      </div>
    </div>
  )
}
