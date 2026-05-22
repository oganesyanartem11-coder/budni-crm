'use client'

import { useState, useMemo, useTransition } from 'react'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Search, Building2, MapPin, ClipboardList } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatClients } from '@/lib/utils/format'
import { ORDER_TYPE_SHORT, MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { getOnboardingStatus, type ClientForOnboarding } from '@/lib/clients/onboarding'
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
      <div className="rounded-2xl bg-surface border border-border p-4 flex flex-col md:flex-row md:items-center gap-3" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-subtle" />
          <input
            type="search"
            placeholder="Поиск по названию клиента, контакту, точке"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm"
          />
        </div>
        <div className="inline-flex rounded-pill border border-border p-0.5 bg-bg text-xs">
          <button
            type="button"
            onClick={() => setStatusFilter('all')}
            className={cn(
              'px-3 py-1 rounded-pill transition-colors',
              statusFilter === 'all'
                ? 'bg-accent text-accent-fg font-medium'
                : 'text-fg-muted hover:text-fg'
            )}
          >
            Все
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('incomplete')}
            className={cn(
              'px-3 py-1 rounded-pill transition-colors',
              statusFilter === 'incomplete'
                ? 'bg-accent text-accent-fg font-medium'
                : 'text-fg-muted hover:text-fg'
            )}
          >
            В настройке
          </button>
        </div>
        <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="rounded"
          />
          Показать архивных
        </label>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          {search ? `Ничего не найдено по запросу «${search}»` : 'Нет клиентов'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

  return (
    <Link
      href={`/clients/${client.id}`}
      className={cn(
        'block rounded-2xl bg-surface border p-5 transition-all',
        client.isActive
          ? 'border-border hover:border-border-strong'
          : 'border-border opacity-60'
      )}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-start gap-3 mb-3">
        <div className="w-12 h-12 rounded-full bg-info-bg text-info-fg flex items-center justify-center font-semibold shrink-0">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold truncate">{client.name}</h3>
          {client.contactName && (
            <p className="text-xs text-fg-muted truncate">
              {client.contactName}
              {client.contactPhone && ` · ${client.contactPhone}`}
            </p>
          )}
        </div>
        {!client.isActive && (
          <span className="px-2 py-0.5 rounded-pill bg-neutral-bg text-neutral-fg text-xs font-medium shrink-0">
            Архив
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
        <Stat icon={MapPin} label="Точек" value={client._count.locations} />
        <Stat icon={Building2} label="Питаний" value={client._count.mealConfigs} />
        <Stat icon={ClipboardList} label="Заказов" value={client._count.orders} />
      </div>

      {client.mealConfigs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {client.mealConfigs.slice(0, 3).map((cfg) => (
            <span
              key={cfg.id}
              className="text-xs px-2 py-0.5 rounded-pill bg-bg text-fg-muted"
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

function Stat({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5 text-fg-muted">
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span>
        <span className="font-semibold text-fg">{value}</span> {label.toLowerCase()}
      </span>
    </div>
  )
}
