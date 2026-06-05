'use client'

import { useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { MapPin, ClipboardList, Plus, Edit2, Archive, ArchiveRestore, Settings, BarChart3, StickyNote, ArrowRight, Phone, AtSign, User, UtensilsCrossed, Mail, Trash2, Contact } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { toast } from 'sonner'
import { LocationModal } from './location-modal'
import { MealConfigModal } from './meal-config-modal'
import { ContactModal } from './contact-modal'
import type { ClientContactDTO } from './contact-actions'
import { deleteClientContact } from './contact-actions'
import { ClientAnalyticsTab } from './client-analytics-tab'
import type { ClientAnalytics } from '@/lib/db/queries/client-analytics'
import { archiveClient, archiveLocation, assignCourierToLocation, deleteMealConfig } from '../actions'
import { formatDateMsk } from '@/lib/utils/format'
import { formatMoney, formatDeliveryWindow, formatOrders } from '@/lib/utils/format'
import {
  ORDER_TYPE_SHORT,
  SCHEDULE_TYPE_LABELS,
  PACKAGING_LABELS,
  MEAL_TYPE_LABELS,
  WEEKDAY_NAMES_SHORT,
} from '@/lib/constants/client'
import { cn } from '@/lib/utils/cn'
import type { Client, ClientLocation, MealType, OrderType, ScheduleType, DeliveryHorizon, Prisma } from '@prisma/client'

// Boris wave 4: deliveryFee — Decimal в БД, serialize() конвертит в number на границе RSC.
// Локация на клиенте видит deliveryFee как number | null, остальные поля — как у Prisma.
type SerializedLocation = Omit<ClientLocation, 'deliveryFee'> & { deliveryFee: number | null }

interface SerializedConfig {
  id: string
  locationId: string | null
  mealType: MealType
  orderType: OrderType
  deliveryHorizon: DeliveryHorizon
  scheduleType: ScheduleType
  scheduleData: Prisma.JsonValue
  fixedPortions: number | null
  pricePerPortion: number
  validFrom: Date | string
  validTo: Date | string | null
  isActive: boolean
  location: { id: string; name: string } | null
}

interface SerializedClientDetail extends Omit<Client, never> {
  contacts: ClientContactDTO[]
  locations: SerializedLocation[]
  mealConfigs: SerializedConfig[]
  defaultOurLegalEntity: {
    id: string
    shortName: string
    entityType: 'INDIVIDUAL_ENTREPRENEUR' | 'LLC'
  } | null
  _count: { orders: number }
}

interface Props {
  client: SerializedClientDetail
  analytics: ClientAnalytics
  // MEGA-BACKEND блок B: активные курьеры для селекта «Курьер» у каждой точки.
  couriers: Array<{ id: string; name: string }>
}

type Tab = 'locations' | 'configs' | 'orders' | 'analytics'

const VALID_TABS: readonly Tab[] = ['locations', 'configs', 'orders', 'analytics']

function isTab(value: string | null): value is Tab {
  return value !== null && (VALID_TABS as readonly string[]).includes(value)
}

export function ClientDetail({ client, analytics, couriers }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  // Sprint 7.11 O-7: ?tab=configs из онбординг-чеклиста скроллит и открывает нужный таб.
  // useSearchParams читает URL и на сервере (SSR), и на клиенте — initial state совпадает.
  const initialTab: Tab = isTab(searchParams.get('tab')) ? (searchParams.get('tab') as Tab) : 'locations'
  const [tab, setTab] = useState<Tab>(initialTab)
  const [, startTransition] = useTransition()

  const [locModal, setLocModal] = useState<{ open: boolean; location?: SerializedLocation }>({ open: false })
  const [cfgModal, setCfgModal] = useState<{ open: boolean; config?: SerializedConfig }>({ open: false })
  const [contactModal, setContactModal] = useState<{ open: boolean; contact?: ClientContactDTO }>({ open: false })

  const activeLocations = client.locations.filter((l) => l.isActive)

  function handleArchiveClient() {
    startTransition(async () => {
      const result = await archiveClient(client.id)
      if (result.ok) {
        toast.success(client.isActive ? 'Клиент в архиве' : 'Клиент восстановлен')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleArchiveLocation(id: string, name: string, isActive: boolean) {
    startTransition(async () => {
      const result = await archiveLocation(id)
      if (result.ok) {
        toast.success(isActive ? `«${name}» в архиве` : `«${name}» восстановлена`)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleDeleteContact(id: string, label: string) {
    if (!window.confirm(`Удалить контакт «${label}»?`)) return
    startTransition(async () => {
      const result = await deleteClientContact(id)
      if (result.ok) {
        toast.success('Контакт удалён')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleArchiveConfig(id: string, isActive: boolean) {
    startTransition(async () => {
      const result = await deleteMealConfig(id)
      if (result.ok) {
        toast.success(isActive ? 'Питание отключено' : 'Питание восстановлено')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const hasRequisites =
    !!client.inn ||
    !!client.legalName ||
    !!client.bankName ||
    !!client.contractNumber ||
    !!client.defaultOurLegalEntity

  const configsCount = client.mealConfigs.filter((c) => c.isActive).length

  return (
    <div id="client-tabs" className="space-y-5 scroll-mt-24">
      <ClientHero client={client} analytics={analytics} />

      <ContactsSection
        contacts={client.contacts}
        onAdd={() => setContactModal({ open: true })}
        onEdit={(c) => setContactModal({ open: true, contact: c })}
        onDelete={handleDeleteContact}
      />

      {(client.notes || hasRequisites) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {client.notes && (
            <div className="rounded-xl bg-surface border border-border p-4 shadow-card">
              <div className="flex items-center gap-2 mb-2">
                <StickyNote className="w-4 h-4 text-warning-fg" />
                <p className="text-xs uppercase tracking-wide text-fg-subtle font-bold">Заметки</p>
              </div>
              <p className="text-sm text-fg whitespace-pre-line">{client.notes}</p>
            </div>
          )}
          {hasRequisites && <RequisitesBlock client={client} />}
        </div>
      )}

      <div
        role="tablist"
        aria-label="Разделы клиента"
        className="inline-flex w-full lg:w-auto bg-surface rounded-pill p-1 gap-0.5 overflow-x-auto scrollbar-none shadow-[var(--shadow-card)]"
      >
        <TabButton active={tab === 'locations'} onClick={() => setTab('locations')} icon={MapPin} label="Точки" count={activeLocations.length} />
        <TabButton active={tab === 'configs'} onClick={() => setTab('configs')} icon={Settings} label="Питание" count={configsCount} />
        <TabButton active={tab === 'orders'} onClick={() => setTab('orders')} icon={ClipboardList} label="Заказы" count={client._count.orders} />
        <TabButton active={tab === 'analytics'} onClick={() => setTab('analytics')} icon={BarChart3} label="Аналитика" />
      </div>

      {tab === 'locations' && (
        <LocationsTab
          locations={client.locations}
          couriers={couriers}
          onAdd={() => setLocModal({ open: true })}
          onEdit={(loc) => setLocModal({ open: true, location: loc })}
          onArchive={handleArchiveLocation}
        />
      )}

      {tab === 'configs' && (
        <ConfigsTab
          configs={client.mealConfigs}
          locations={activeLocations}
          onAdd={() => setCfgModal({ open: true })}
          onEdit={(cfg) => setCfgModal({ open: true, config: cfg })}
          onArchive={handleArchiveConfig}
        />
      )}

      {tab === 'orders' && (
        <div className="rounded-3xl bg-surface border border-border p-8 text-center shadow-card">
          <ClipboardList className="w-10 h-10 mx-auto text-fg-subtle mb-3" />
          <p className="font-medium text-fg mb-1">{formatOrders(client._count.orders)} в истории</p>
          <p className="text-sm text-fg-muted mb-5">
            Открыть полный список заказов этого клиента в разделе «Заказы».
          </p>
          <Link
            href={`/orders?clientId=${client.id}`}
            style={{ background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' }}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-opacity min-h-[44px] [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <ClipboardList className="w-4 h-4" />
            Открыть все заказы
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      )}

      {tab === 'analytics' && <ClientAnalyticsTab analytics={analytics} />}

      <div className="pt-4 border-t border-border">
        <button
          type="button"
          onClick={handleArchiveClient}
          className={cn(
            'inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors min-h-[44px] [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring-orange)]',
            client.isActive
              ? 'bg-surface text-danger-fg border border-danger/30 hover:bg-danger-bg'
              : 'bg-success text-white border border-transparent hover:opacity-90'
          )}
        >
          {client.isActive ? <><Archive className="w-4 h-4" /> Архивировать клиента</> : <><ArchiveRestore className="w-4 h-4" /> Восстановить клиента</>}
        </button>
      </div>

      <LocationModal
        clientId={client.id}
        location={locModal.location}
        open={locModal.open}
        onClose={() => setLocModal({ open: false })}
      />

      <MealConfigModal
        clientId={client.id}
        locations={activeLocations.map((l) => ({ id: l.id, name: l.name }))}
        config={cfgModal.config}
        open={cfgModal.open}
        onClose={() => setCfgModal({ open: false })}
      />

      <ContactModal
        clientId={client.id}
        contact={contactModal.contact}
        open={contactModal.open}
        onClose={() => setContactModal({ open: false })}
      />
    </div>
  )
}

function ClientHero({ client, analytics }: { client: SerializedClientDetail; analytics: ClientAnalytics }) {
  const contactBits: Array<{ icon: React.ComponentType<{ className?: string }>; text: string }> = []
  if (client.contactName) contactBits.push({ icon: User, text: client.contactName })
  if (client.contactPhone) contactBits.push({ icon: Phone, text: client.contactPhone })
  if (client.contactMessenger) contactBits.push({ icon: AtSign, text: client.contactMessenger })

  return (
    <div className="rounded-3xl bg-surface border border-border p-6 shadow-card">
      {/* Заголовок + CTA */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display font-extrabold text-3xl lg:text-4xl text-fg-strong leading-tight">
              {client.name}
            </h1>
            {!client.isActive && (
              <span className="shrink-0 px-2.5 py-1 rounded-full bg-neutral-bg text-neutral-fg text-xs font-bold uppercase tracking-wide">
                Архив
              </span>
            )}
          </div>
          {contactBits.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-sm text-fg-muted">
              {contactBits.map((bit, i) => (
                <span key={i} className="inline-flex items-center gap-1.5">
                  <bit.icon className="w-4 h-4 text-fg-subtle" />
                  {bit.text}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 lg:shrink-0">
          {/* «Написать в MAX» намеренно опущена: единственный паттерн открытия чата
              (https://max.ru/<maxUsername>) завязан на maxUsername, а не на maxChatId.
              URL из maxChatId не выдумываем. См. todosForArtem. */}
          <Link
            href={`/clients/${client.id}/edit`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-surface border border-border text-fg font-medium text-sm hover:bg-surface-2 transition-colors min-h-[44px] [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <Edit2 className="w-4 h-4" />
            Редактировать
          </Link>
        </div>
      </div>

      {/* Большая метрика */}
      <div className="mt-6">
        <p className="text-xs uppercase tracking-wide text-fg-subtle font-bold">Всего от клиента</p>
        <p className="font-display font-extrabold text-5xl text-fg-strong tabular-nums leading-none mt-1.5">
          {formatMoney(analytics.totalRevenue)}
        </p>
      </div>

      {/* Мини-метрики */}
      <div className="grid grid-cols-3 gap-3 mt-5">
        <HeroStat value={analytics.totalOrders.toLocaleString('ru-RU')} label="заказов" tone="revenue" />
        <HeroStat value={analytics.totalPortions.toLocaleString('ru-RU')} label="порций" tone="orders" />
        <HeroStat value={formatMoney(analytics.averageOrder)} label="средний чек" tone="amount" />
      </div>

      {/* Бейджи */}
      <div className="flex flex-wrap gap-2 mt-5">
        <span className="inline-flex items-center px-3 py-1 rounded-full bg-surface-2 text-fg-muted text-xs font-medium">
          Создан {formatDateMsk(client.createdAt)}
        </span>
        {/* Бейдж «Последний заказ N дней назад» опущен: ClientAnalytics не содержит
            даты последнего заказа (только weekly/monthly ряды). Query не добавляем. */}
      </div>
    </div>
  )
}

function HeroStat({ value, label, tone }: { value: string; label: string; tone: 'revenue' | 'orders' | 'amount' }) {
  const toneClasses: Record<typeof tone, { bg: string; ink: string }> = {
    revenue: { bg: 'bg-data-revenue-bg', ink: 'text-data-revenue-ink' },
    orders: { bg: 'bg-data-orders-bg', ink: 'text-data-orders-ink' },
    amount: { bg: 'bg-data-amount-bg', ink: 'text-data-amount-ink' },
  }
  const t = toneClasses[tone]
  return (
    <div className={cn('rounded-2xl p-4', t.bg)}>
      <p className="font-display font-bold text-xl text-fg-strong tabular-nums leading-tight">{value}</p>
      <p className={cn('text-xs mt-0.5', t.ink)}>{label}</p>
    </div>
  )
}

function TabButton({ active, onClick, icon: Icon, label, count }: { active: boolean; onClick: () => void; icon: React.ComponentType<{ className?: string }>; label: string; count?: number }) {
  return (
    <button
      type="button"
      role="tab"
      onClick={onClick}
      aria-pressed={active}
      aria-selected={active}
      className={cn(
        'shrink-0 flex-1 lg:flex-none px-4 py-2.5 rounded-pill min-h-[44px] [touch-action:manipulation] text-sm font-medium transition-colors flex items-center justify-center gap-2 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        active ? 'bg-primary text-primary-foreground shadow-[var(--shadow-capsule)]' : 'text-fg-muted hover:text-fg'
      )}
    >
      <Icon className="w-4 h-4" />
      {label}
      {count !== undefined && (
        <span className={cn(
          'px-1.5 py-0.5 rounded-pill text-xs font-bold tabular-nums leading-none',
          active ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-data-revenue-bg text-data-revenue-ink'
        )}>
          {count}
        </span>
      )}
    </button>
  )
}

function LocationsTab({
  locations,
  couriers,
  onAdd,
  onEdit,
  onArchive,
}: {
  locations: SerializedLocation[]
  // MEGA-BACKEND блок B: список активных курьеров для селекта «Курьер».
  couriers: Array<{ id: string; name: string }>
  onAdd: () => void
  onEdit: (loc: SerializedLocation) => void
  onArchive: (id: string, name: string, isActive: boolean) => void
}) {
  const [, startTransition] = useTransition()

  function handleAssignCourier(locationId: string, courierId: string | null) {
    startTransition(async () => {
      const r = await assignCourierToLocation(locationId, courierId)
      if (!r.ok) toast.error(r.error)
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button type="button" onClick={onAdd} style={{ background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' }} className="px-5 py-2.5 min-h-[44px] rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-opacity flex items-center justify-center gap-2 [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
          <Plus className="w-4 h-4" /> Добавить точку
        </button>
      </div>

      {locations.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="Точек пока нет"
          description="Добавьте первую точку доставки клиента"
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {locations.map((loc) => (
            <div
              key={loc.id}
              className={cn(
                'rounded-2xl bg-surface border p-5',
                loc.isActive ? 'border-border' : 'border-border opacity-60'
              )}
              style={{ boxShadow: 'var(--shadow-card)' }}
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold truncate">{loc.name}</h3>
                  <p className="text-sm text-fg-muted">{loc.address}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" onClick={() => onEdit(loc)} aria-label="Редактировать" className="min-w-[44px] min-h-[44px] rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors [touch-action:manipulation]">
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button type="button" onClick={() => onArchive(loc.id, loc.name, loc.isActive)} aria-label={loc.isActive ? 'В архив' : 'Восстановить'} className="min-w-[44px] min-h-[44px] rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors [touch-action:manipulation]">
                    {loc.isActive ? <Archive className="w-4 h-4" /> : <ArchiveRestore className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-xs text-fg-muted mt-3">
                <span className="px-2 py-0.5 rounded-pill bg-bg">
                  {formatDeliveryWindow(loc.deliveryWindowFrom, loc.deliveryWindowTo)}
                </span>
                <span className="px-2 py-0.5 rounded-pill bg-bg">
                  {PACKAGING_LABELS[loc.packaging]}
                </span>
              </div>
              {loc.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {loc.tags.map((t) => (
                    <span key={t} className="text-xs px-2 py-0.5 rounded-pill bg-warning-bg text-warning-fg font-medium">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {/* MEGA-BACKEND блок B: назначение курьера на точку. Пустое значение = «не назначен» (точку видят все курьеры). */}
              <div className="mt-3 flex items-center gap-2">
                <label className="text-xs text-fg-muted shrink-0">Курьер:</label>
                <select
                  value={loc.assignedCourierId ?? ''}
                  onChange={(e) => handleAssignCourier(loc.id, e.target.value || null)}
                  className="flex-1 min-w-0 text-sm px-3 py-1.5 rounded-pill bg-bg border border-border text-fg focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  <option value="">Не назначен</option>
                  {couriers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ConfigsTab({
  configs,
  locations,
  onAdd,
  onEdit,
  onArchive,
}: {
  configs: SerializedConfig[]
  locations: Array<Pick<ClientLocation, 'id' | 'name'>>
  onAdd: () => void
  onEdit: (cfg: SerializedConfig) => void
  onArchive: (id: string, isActive: boolean) => void
}) {
  function describeSchedule(cfg: SerializedConfig): string {
    const data = cfg.scheduleData
    if (cfg.scheduleType === 'CUSTOM_DAYS') {
      if (data && typeof data === 'object' && !Array.isArray(data) && 'daysOfWeek' in data) {
        const days = data.daysOfWeek
        if (Array.isArray(days)) {
          return days
            .filter((d): d is number => typeof d === 'number')
            .map((d) => WEEKDAY_NAMES_SHORT[d])
            .join(', ')
        }
      }
      return 'Свои дни'
    }
    if (cfg.scheduleType === 'INTERVAL') {
      if (data && typeof data === 'object' && !Array.isArray(data) && 'intervalDays' in data) {
        const interval = data.intervalDays
        if (typeof interval === 'number') {
          return `Каждые ${interval} дн.`
        }
      }
      return 'Интервал'
    }
    return SCHEDULE_TYPE_LABELS[cfg.scheduleType]
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <p className="text-sm text-fg-muted">
          Питание определяет, что и куда поставлять клиенту: тип, график, цену.
        </p>
        <button type="button" onClick={onAdd} disabled={locations.length === 0} style={{ background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' }} className="px-5 py-2.5 min-h-[44px] rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-opacity flex items-center justify-center gap-2 [touch-action:manipulation] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
          <Plus className="w-4 h-4" /> Добавить питание
        </button>
      </div>

      {locations.length === 0 ? (
        <div className="rounded-2xl bg-warning-bg/30 border border-warning/20 px-5 py-4 text-sm text-warning-fg">
          Сначала добавьте хотя бы одну точку — питание привязывается к ней.
        </div>
      ) : configs.length === 0 ? (
        <EmptyState
          icon={UtensilsCrossed}
          title="Расписаний питания пока нет"
          description="Настройте FIX-расписание для регулярных заказов"
        />
      ) : (
        <div className="rounded-2xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg/50 text-xs uppercase tracking-wider text-fg-muted">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Точка</th>
                  <th className="text-left px-3 py-3 font-medium">Тип</th>
                  <th className="text-left px-3 py-3 font-medium">График</th>
                  <th className="text-right px-3 py-3 font-medium">Порций</th>
                  <th className="text-right px-3 py-3 font-medium">Цена</th>
                  <th className="px-3 py-3 w-20"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {configs.map((cfg) => (
                  <tr key={cfg.id} className={cn(!cfg.isActive && 'opacity-50')}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{cfg.location?.name ?? <span className="text-fg-muted">Все точки</span>}</div>
                    </td>
                    <td className="px-3 py-3">
                      <div>{MEAL_TYPE_LABELS[cfg.mealType]}</div>
                      <div className="text-xs text-fg-muted">{ORDER_TYPE_SHORT[cfg.orderType]}</div>
                    </td>
                    <td className="px-3 py-3 text-fg-muted">{describeSchedule(cfg)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {cfg.fixedPortions ?? '—'}
                    </td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums whitespace-nowrap">
                      {formatMoney(cfg.pricePerPortion)}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button type="button" onClick={() => onEdit(cfg)} aria-label="Редактировать" className="min-w-[44px] min-h-[44px] rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors [touch-action:manipulation]">
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button type="button" onClick={() => onArchive(cfg.id, cfg.isActive)} aria-label={cfg.isActive ? 'Отключить' : 'Включить'} className="min-w-[44px] min-h-[44px] rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors [touch-action:manipulation]">
                          {cfg.isActive ? <Archive className="w-4 h-4" /> : <ArchiveRestore className="w-4 h-4" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function ContactsSection({
  contacts,
  onAdd,
  onEdit,
  onDelete,
}: {
  contacts: ClientContactDTO[]
  onAdd: () => void
  onEdit: (c: ClientContactDTO) => void
  onDelete: (id: string, label: string) => void
}) {
  return (
    <div className="rounded-xl bg-surface border border-border p-4 shadow-card">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Contact className="w-4 h-4 text-fg-subtle" />
          <p className="text-xs uppercase tracking-wide text-fg-subtle font-bold">Контактные лица</p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill bg-surface-2 hover:bg-border text-fg-muted hover:text-fg text-sm font-medium transition-colors min-h-[36px] [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <Plus className="w-4 h-4" /> Добавить контакт
        </button>
      </div>

      {contacts.length === 0 ? (
        <p className="text-sm text-fg-muted">Контактных лиц пока нет.</p>
      ) : (
        <div className="space-y-2">
          {contacts.map((c) => {
            const label = c.name || c.role || c.phone
            return (
              <div
                key={c.id}
                className="flex items-start justify-between gap-3 rounded-xl bg-bg/40 border border-border px-3.5 py-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {c.name && <span className="font-semibold text-fg-strong">{c.name}</span>}
                    {c.role && (
                      <span className="text-xs px-2 py-0.5 rounded-pill bg-warning-bg text-warning-fg font-medium">
                        {c.role}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <Phone className="w-3.5 h-3.5 text-fg-subtle" />
                      {c.phone}
                    </span>
                    {c.email && (
                      <span className="inline-flex items-center gap-1.5 min-w-0">
                        <Mail className="w-3.5 h-3.5 text-fg-subtle shrink-0" />
                        <span className="truncate">{c.email}</span>
                      </span>
                    )}
                  </div>
                  {c.notes && <p className="text-sm text-fg-muted whitespace-pre-line">{c.notes}</p>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => onEdit(c)}
                    aria-label="Редактировать"
                    className="min-w-[44px] min-h-[44px] rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors [touch-action:manipulation]"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(c.id, label)}
                    aria-label="Удалить"
                    className="min-w-[44px] min-h-[44px] rounded-full hover:bg-danger-bg flex items-center justify-center text-fg-muted hover:text-danger-fg transition-colors [touch-action:manipulation]"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RequisitesBlock({ client }: { client: SerializedClientDetail }) {
  const contractDateStr = client.contractDate ? formatDateMsk(client.contractDate) : null

  return (
    <details className="group rounded-xl bg-surface border border-border p-4 shadow-card">
      <summary className="flex items-center justify-between gap-2 cursor-pointer list-none select-none [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded">
        <span className="text-xs font-bold uppercase tracking-wide text-fg-subtle">
          Реквизиты юр.лица
        </span>
        <span className="text-fg-subtle text-xs transition-transform group-open:rotate-180" aria-hidden>
          ▾
        </span>
      </summary>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 text-sm mt-4">
        {/* Юр.реквизиты */}
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-fg-subtle">Юридические</p>
          <RequisitesRow label="Название" value={client.legalName} />
          <RequisitesRow label="ИНН" value={client.inn} mono />
          <RequisitesRow label="КПП" value={client.kpp} mono />
          <RequisitesRow label="ОГРН/ОГРНИП" value={client.ogrn} mono />
          <RequisitesRow label="Юр. адрес" value={client.legalAddress} multiline />
        </div>

        {/* Банк */}
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-fg-subtle">Банк</p>
          <RequisitesRow label="Наименование" value={client.bankName} />
          <RequisitesRow label="БИК" value={client.bankBic} mono />
          <RequisitesRow label="Р/с" value={client.bankAccount} mono />
          <RequisitesRow label="Корр. счёт" value={client.bankCorrAccount} mono />
        </div>

        {/* Договор */}
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-fg-subtle">Договор</p>
          <RequisitesRow label="Номер" value={client.contractNumber} />
          <RequisitesRow label="Дата" value={contractDateStr} />
        </div>

        {/* Наше юрлицо */}
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-fg-subtle">Отгрузка от нас</p>
          <RequisitesRow
            label="Наше юрлицо"
            value={
              client.defaultOurLegalEntity
                ? `${client.defaultOurLegalEntity.shortName} (${
                    client.defaultOurLegalEntity.entityType === 'LLC' ? 'ООО' : 'ИП'
                  })`
                : null
            }
          />
        </div>
      </div>
    </details>
  )
}

function RequisitesRow({
  label,
  value,
  mono,
  multiline,
}: {
  label: string
  value: string | null | undefined
  mono?: boolean
  multiline?: boolean
}) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-fg-muted shrink-0 w-28">{label}:</span>
      <span
        className={cn(
          'flex-1 min-w-0',
          mono && 'font-mono tabular-nums',
          multiline ? 'whitespace-pre-line break-words' : 'truncate'
        )}
      >
        {value && value !== '' ? value : <span className="text-fg-subtle">—</span>}
      </span>
    </div>
  )
}
