'use client'

import { useState, useTransition, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { createOrder, findDuplicateOrder, getClientForOrderForm } from '../actions'
import { formatMoney, formatDateLong, formatPortions } from '@/lib/utils/format'
import { MEAL_TYPE_LABELS, ORDER_TYPE_SHORT, PACKAGING_LABELS } from '@/lib/constants/client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils/cn'
import type { MealType, OrderType, PackagingType } from '@prisma/client'

interface ClientLocationLight {
  id: string
  name: string
  address: string
  packaging: PackagingType
}

interface MealConfigLight {
  id: string
  locationId: string | null
  mealType: MealType
  orderType: OrderType
  fixedPortions: number | null
  pricePerPortion: number
}

interface ClientFull {
  id: string
  name: string
  locations: ClientLocationLight[]
  mealConfigs: MealConfigLight[]
}

interface DuplicateInfo {
  id: string
  portions: number
  status: string
}

interface Props {
  clients: Array<{ id: string; name: string }>
  defaultDate: string
  defaultClientId: string | null
}

export function OrderForm({ clients, defaultDate, defaultClientId }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isLoadingClient, setIsLoadingClient] = useState(false)

  const [clientId, setClientId] = useState(defaultClientId ?? '')
  const [client, setClient] = useState<ClientFull | null>(null)
  const [locationId, setLocationId] = useState('')
  const [mealType, setMealType] = useState<MealType>('LUNCH')
  const [deliveryDate, setDeliveryDate] = useState(defaultDate)
  const [portions, setPortions] = useState('')
  const [pricePerPortion, setPricePerPortion] = useState('')
  const [matchedConfig, setMatchedConfig] = useState<MealConfigLight | null>(null)
  const [notes, setNotes] = useState('')
  const [duplicate, setDuplicate] = useState<DuplicateInfo | null>(null)
  const [dupAcknowledged, setDupAcknowledged] = useState(false)
  const [overridePrice, setOverridePrice] = useState(false)

  // При смене любого ключа дубль-проверки сбрасываем подтверждение —
  // нельзя залипшим чекбоксом обойти warning на следующем дубле.
  useEffect(() => {
    setDupAcknowledged(false)
  }, [duplicate?.id])

  useEffect(() => {
    if (!clientId) {
      setClient(null)
      setLocationId('')
      return
    }

    setIsLoadingClient(true)
    getClientForOrderForm(clientId)
      .then((data) => {
        setClient(data)
        if (data && data.locations.length === 1) {
          setLocationId(data.locations[0].id)
        } else {
          setLocationId('')
        }
      })
      .catch(() => {
        toast.error('Не удалось загрузить данные клиента')
      })
      .finally(() => {
        setIsLoadingClient(false)
      })
  }, [clientId])

  useEffect(() => {
    if (!client || !locationId || !mealType) {
      setMatchedConfig(null)
      return
    }

    const exact = client.mealConfigs.find(
      (c) => c.mealType === mealType && c.locationId === locationId
    )
    const fallback = client.mealConfigs.find(
      (c) => c.mealType === mealType && c.locationId === null
    )
    const config = exact ?? fallback ?? null

    setMatchedConfig(config)

    if (config) {
      if (!overridePrice) {
        setPricePerPortion(String(config.pricePerPortion))
      }
      if (config.orderType === 'FIXED' && config.fixedPortions && !portions) {
        setPortions(String(config.fixedPortions))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, locationId, mealType])

  useEffect(() => {
    if (!clientId || !locationId || !mealType || !deliveryDate) {
      setDuplicate(null)
      return
    }

    const t = setTimeout(() => {
      findDuplicateOrder({ clientId, locationId, mealType, deliveryDate })
        .then((res) => {
          setDuplicate(res.exists && res.order ? res.order : null)
        })
        .catch(() => setDuplicate(null))
    }, 400)

    return () => clearTimeout(t)
  }, [clientId, locationId, mealType, deliveryDate])

  const portionsNum = parseInt(portions, 10) || 0
  const priceNum = parseFloat(pricePerPortion) || 0
  const totalPrice = portionsNum * priceNum

  const selectedLocation = client?.locations.find((l) => l.id === locationId) ?? null

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!clientId) return toast.error('Выберите клиента')
    if (!locationId) return toast.error('Выберите точку')
    if (portionsNum <= 0) return toast.error('Введите количество порций')
    if (priceNum < 0) return toast.error('Цена не может быть отрицательной')

    startTransition(async () => {
      const result = await createOrder({
        clientId,
        locationId,
        mealType,
        deliveryDate,
        portions: portionsNum,
        pricePerPortion: priceNum,
        notes: notes.trim() || null,
        configId: matchedConfig?.id ?? null,
      })

      if (result.ok) {
        toast.success('Заказ создан')
        const dateStr = result.data.deliveryDate
        router.push(`/orders?date=${encodeURIComponent(dateStr)}`)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">
      <div className="space-y-4">
        <div className="rounded-2xl bg-surface border border-border p-5 space-y-4" style={{ boxShadow: 'var(--shadow-card)' }}>
          <h2 className="text-base font-semibold">Параметры заказа</h2>

          <Field label="Клиент *">
            <Select value={clientId || undefined} onValueChange={(v) => setClientId(v)}>
              <SelectTrigger aria-required="true" className="w-full !h-auto px-3 py-2.5 rounded-xl bg-surface border-border focus-visible:border-brand-green focus-visible:ring-2 focus-visible:ring-brand-green/30 transition-colors data-placeholder:text-fg-muted">
                <SelectValue placeholder="— выберите —" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Точка *" hint={isLoadingClient ? 'Загрузка точек...' : undefined}>
            <Select value={locationId || undefined} onValueChange={(v) => setLocationId(v)}>
              <SelectTrigger
                aria-required="true"
                disabled={!client || isLoadingClient}
                className="w-full !h-auto px-3 py-2.5 rounded-xl bg-surface border-border focus-visible:border-brand-green focus-visible:ring-2 focus-visible:ring-brand-green/30 transition-colors data-placeholder:text-fg-muted disabled:opacity-50"
              >
                <SelectValue placeholder={!client ? 'Сначала выберите клиента' : '— выберите —'} />
              </SelectTrigger>
              <SelectContent>
                {client?.locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.name} · {l.address}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Дата доставки *">
              <input
                type="date"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:ring-2 focus:ring-brand-green/30 focus:border-brand-green transition-colors"
              />
            </Field>
            <Field label="Тип питания *">
              <Select value={mealType} onValueChange={(v) => setMealType(v as MealType)}>
                <SelectTrigger aria-required="true" className="w-full !h-auto px-3 py-2.5 rounded-xl bg-surface border-border focus-visible:border-brand-green focus-visible:ring-2 focus-visible:ring-brand-green/30 transition-colors data-placeholder:text-fg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BREAKFAST">{MEAL_TYPE_LABELS.BREAKFAST}</SelectItem>
                  <SelectItem value="LUNCH">{MEAL_TYPE_LABELS.LUNCH}</SelectItem>
                  <SelectItem value="DINNER">{MEAL_TYPE_LABELS.DINNER}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {matchedConfig && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-info-bg/40 border border-info/20">
              <Sparkles className="w-4 h-4 text-info-fg shrink-0 mt-0.5" />
              <p className="text-xs text-info-fg">
                Найдено питание · тип <strong>{ORDER_TYPE_SHORT[matchedConfig.orderType]}</strong> · цена и порции подставлены автоматически
              </p>
            </div>
          )}

          {!matchedConfig && client && locationId && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-warning-bg/40 border border-warning/20">
              <AlertTriangle className="w-4 h-4 text-warning-fg shrink-0 mt-0.5" />
              <p className="text-xs text-warning-fg">
                У клиента нет питания для этой точки/типа. Введите цену вручную.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Порций *">
              <input
                type="number"
                min="1"
                value={portions}
                onChange={(e) => setPortions(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:ring-2 focus:ring-brand-green/30 focus:border-brand-green transition-colors tabular-nums"
              />
            </Field>
            <Field
              label="Цена за порцию, ₽ *"
              hint={matchedConfig && !overridePrice ? 'Из питания клиента' : undefined}
            >
              <input
                type="number"
                min="0"
                step="0.01"
                value={pricePerPortion}
                onChange={(e) => {
                  setPricePerPortion(e.target.value)
                  setOverridePrice(true)
                }}
                className="w-full px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:ring-2 focus:ring-brand-green/30 focus:border-brand-green transition-colors tabular-nums"
              />
            </Field>
          </div>

          <Field label="Заметки">
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Особые пожелания клиента"
              className="w-full px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:ring-2 focus:ring-brand-green/30 focus:border-brand-green transition-colors resize-none"
            />
          </Field>
        </div>

        {duplicate && (
          <div className="rounded-2xl bg-danger-bg/40 border border-danger/30 p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-danger-fg shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm text-danger-fg">Заказ на эту дату уже существует</p>
              <p className="text-xs text-danger-fg/80 mt-1">
                {formatPortions(duplicate.portions)} · статус: {duplicate.status}. Создание ещё одного приведёт к дублю.
              </p>
              <label className="mt-3 flex items-center gap-2 text-xs text-danger-fg cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={dupAcknowledged}
                  onChange={(e) => setDupAcknowledged(e.target.checked)}
                  className="rounded border-danger/40"
                />
                Понимаю, всё равно создать
              </label>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div className="rounded-2xl bg-surface border border-border p-5 sticky top-4" style={{ boxShadow: 'var(--shadow-card)' }}>
          <h2 className="text-base font-semibold mb-4">Превью</h2>

          <dl className="space-y-2.5 text-sm">
            <Row label="Клиент" value={client?.name ?? '—'} />
            <Row label="Точка" value={selectedLocation?.name ?? '—'} />
            {selectedLocation && (
              <Row label="Упаковка" value={PACKAGING_LABELS[selectedLocation.packaging]} subtle />
            )}
            <Row label="Дата" value={deliveryDate ? formatDateLong(new Date(deliveryDate)) : '—'} />
            <Row label="Тип" value={MEAL_TYPE_LABELS[mealType]} />
            <Row label="Порций" value={portionsNum > 0 ? String(portionsNum) : '—'} />
            <Row label="Цена" value={priceNum > 0 ? formatMoney(priceNum) : '—'} subtle />
          </dl>

          <div className="border-t border-border my-4" />

          <div className="flex items-baseline justify-between">
            <span className="text-sm text-fg-muted">Сумма</span>
            <span className="text-2xl font-bold tabular-nums">
              {totalPrice > 0 ? formatMoney(totalPrice) : '—'}
            </span>
          </div>

          <div className="mt-5 space-y-2">
            <button
              type="submit"
              disabled={isPending || !clientId || !locationId || portionsNum <= 0 || (!!duplicate && !dupAcknowledged)}
              className="w-full px-5 py-3 rounded-xl bg-brand-orange text-white font-medium text-sm hover:bg-brand-orange-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/40"
            >
              {isPending ? 'Создаём…' : 'Создать заказ'}
            </button>
            <Link
              href="/orders"
              className="block text-center w-full px-5 py-2.5 rounded-xl bg-brand-green-light text-brand-green-deep font-medium text-sm hover:bg-brand-green-light/70 transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30"
            >
              Отмена
            </Link>
          </div>
        </div>
      </div>
    </form>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
    </div>
  )
}

function Row({ label, value, subtle = false }: { label: string; value: string; subtle?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-fg-muted text-xs uppercase tracking-wider">{label}</dt>
      <dd className={cn('font-medium text-right truncate', subtle && 'text-fg-muted font-normal')}>
        {value}
      </dd>
    </div>
  )
}
