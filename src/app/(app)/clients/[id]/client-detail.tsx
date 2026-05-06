'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MapPin, ClipboardList, Plus, Edit2, Archive, ArchiveRestore, Settings, BarChart3 } from 'lucide-react'
import { toast } from 'sonner'
import { LocationModal } from './location-modal'
import { MealConfigModal } from './meal-config-modal'
import { archiveClient, archiveLocation, deleteMealConfig } from '../actions'
import { formatMoney, formatDeliveryWindow } from '@/lib/utils/format'
import {
  ORDER_TYPE_SHORT,
  SCHEDULE_TYPE_LABELS,
  PACKAGING_LABELS,
  MEAL_TYPE_LABELS,
  WEEKDAY_NAMES_SHORT,
} from '@/lib/constants/client'
import { cn } from '@/lib/utils/cn'
import type { Client, ClientLocation, MealType, OrderType, ScheduleType, DeliveryHorizon, Prisma } from '@prisma/client'

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
  locations: ClientLocation[]
  mealConfigs: SerializedConfig[]
  _count: { orders: number }
}

interface Props {
  client: SerializedClientDetail
}

type Tab = 'locations' | 'configs' | 'orders' | 'analytics'

export function ClientDetail({ client }: Props) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('locations')
  const [, startTransition] = useTransition()

  const [locModal, setLocModal] = useState<{ open: boolean; location?: ClientLocation }>({ open: false })
  const [cfgModal, setCfgModal] = useState<{ open: boolean; config?: SerializedConfig }>({ open: false })

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

  function handleArchiveConfig(id: string, isActive: boolean) {
    startTransition(async () => {
      const result = await deleteMealConfig(id)
      if (result.ok) {
        toast.success(isActive ? 'Конфиг отключён' : 'Конфиг восстановлен')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div className="space-y-5">
      {client.notes && (
        <div className="rounded-2xl bg-warning-bg/30 border border-warning/20 px-5 py-4">
          <p className="text-xs uppercase tracking-wider text-warning-fg/80 font-medium mb-1">Заметки</p>
          <p className="text-sm text-fg whitespace-pre-line">{client.notes}</p>
        </div>
      )}

      <div className="flex items-center gap-1 p-1 bg-bg rounded-pill w-fit overflow-x-auto">
        <TabButton active={tab === 'locations'} onClick={() => setTab('locations')} icon={MapPin} label={`Точки · ${activeLocations.length}`} />
        <TabButton active={tab === 'configs'} onClick={() => setTab('configs')} icon={Settings} label={`Питание · ${client.mealConfigs.filter((c) => c.isActive).length}`} />
        <TabButton active={tab === 'orders'} onClick={() => setTab('orders')} icon={ClipboardList} label={`Заказы · ${client._count.orders}`} />
        <TabButton active={tab === 'analytics'} onClick={() => setTab('analytics')} icon={BarChart3} label="Аналитика" />
      </div>

      {tab === 'locations' && (
        <LocationsTab
          locations={client.locations}
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
        <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          <ClipboardList className="w-10 h-10 mx-auto text-fg-subtle mb-3" />
          <p className="font-medium text-fg mb-1">{client._count.orders} заказов в истории</p>
          <p className="text-sm">Реализация — Спринт 2</p>
        </div>
      )}

      {tab === 'analytics' && (
        <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          <BarChart3 className="w-10 h-10 mx-auto text-fg-subtle mb-3" />
          <p className="font-medium text-fg mb-1">Аналитика клиента</p>
          <p className="text-sm">Реализация — Спринт 4</p>
        </div>
      )}

      <div className="pt-4 border-t border-border">
        <button
          type="button"
          onClick={handleArchiveClient}
          className={cn(
            'inline-flex items-center gap-2 px-4 py-2 rounded-pill text-sm font-medium transition-colors',
            client.isActive
              ? 'text-danger-fg bg-danger-bg/40 hover:bg-danger-bg'
              : 'text-success-fg bg-success-bg/40 hover:bg-success-bg'
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
    </div>
  )
}

function TabButton({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 px-4 py-2 rounded-pill text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap',
        active ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:text-fg'
      )}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  )
}

function LocationsTab({
  locations,
  onAdd,
  onEdit,
  onArchive,
}: {
  locations: ClientLocation[]
  onAdd: () => void
  onEdit: (loc: ClientLocation) => void
  onArchive: (id: string, name: string, isActive: boolean) => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button type="button" onClick={onAdd} className="px-4 py-2 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2">
          <Plus className="w-4 h-4" /> Добавить точку
        </button>
      </div>

      {locations.length === 0 ? (
        <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          <MapPin className="w-10 h-10 mx-auto text-fg-subtle mb-3" />
          <p>Нет точек. Добавьте первую.</p>
        </div>
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
                  <button type="button" onClick={() => onEdit(loc)} aria-label="Редактировать" className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors">
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button type="button" onClick={() => onArchive(loc.id, loc.name, loc.isActive)} aria-label={loc.isActive ? 'В архив' : 'Восстановить'} className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors">
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
          Конфиги питания определяют что и как заказывает клиент: тип, график, цену.
        </p>
        <button type="button" onClick={onAdd} disabled={locations.length === 0} className="px-4 py-2 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2 disabled:opacity-50">
          <Plus className="w-4 h-4" /> Добавить конфиг
        </button>
      </div>

      {locations.length === 0 ? (
        <div className="rounded-2xl bg-warning-bg/30 border border-warning/20 px-5 py-4 text-sm text-warning-fg">
          Сначала добавьте хотя бы одну точку — конфиг привязывается к ней.
        </div>
      ) : configs.length === 0 ? (
        <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          <Settings className="w-10 h-10 mx-auto text-fg-subtle mb-3" />
          <p>Нет конфигов питания. Добавьте первый.</p>
        </div>
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
                        <button type="button" onClick={() => onEdit(cfg)} aria-label="Редактировать" className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors">
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button type="button" onClick={() => onArchive(cfg.id, cfg.isActive)} aria-label={cfg.isActive ? 'Отключить' : 'Включить'} className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors">
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
