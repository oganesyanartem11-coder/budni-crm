'use client'

import { useState, useTransition, useEffect } from 'react'
import { X, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { createMealConfigBulk, updateMealConfig } from '../actions'
import {
  MEAL_TYPE_LABELS,
  ORDER_TYPE_LABELS,
  SCHEDULE_TYPE_LABELS,
  DELIVERY_HORIZON_LABELS,
  WEEKDAY_NAMES_SHORT,
} from '@/lib/constants/client'
import { cn } from '@/lib/utils/cn'
import type { ClientLocation, MealType, OrderType, ScheduleType, DeliveryHorizon, Prisma } from '@prisma/client'

interface ConfigData {
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
}

interface Props {
  clientId: string
  locations: Array<Pick<ClientLocation, 'id' | 'name'>>
  config?: ConfigData
  open: boolean
  onClose: () => void
}

const MEAL_TYPES_ORDER: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER']

export function MealConfigModal({ clientId, locations, config, open, onClose }: Props) {
  const isEditing = !!config
  const [isPending, startTransition] = useTransition()

  // При создании, если у клиента ровно одна локация — преселектим её.
  // При редактировании сохраняем существующий locationId.
  // Иначе пусто — пользователь обязан выбрать (см. handleSubmit).
  const [locationId, setLocationId] = useState<string>(() => {
    if (config?.locationId) return config.locationId
    if (!config && locations.length === 1) return locations[0].id
    return ''
  })
  const [orderType, setOrderType] = useState<OrderType>(config?.orderType ?? 'FIXED')
  const [deliveryHorizon, setDeliveryHorizon] = useState<DeliveryHorizon>(config?.deliveryHorizon ?? 'NEXT_DAY')
  const [scheduleType, setScheduleType] = useState<ScheduleType>(config?.scheduleType ?? 'WEEKDAYS')

  // При редактировании — один тип; при создании — массив выбранных
  const [selectedTypes, setSelectedTypes] = useState<MealType[]>(
    config ? [config.mealType] : ['LUNCH']
  )

  // Цены по типам: при редактировании единственный тип, при создании — все выбранные
  const [pricesByType, setPricesByType] = useState<Record<string, string>>(() => {
    if (config) return { [config.mealType]: String(config.pricePerPortion) }
    return { LUNCH: '' }
  })

  const [portionsByType, setPortionsByType] = useState<Record<string, string>>(() => {
    if (config) return { [config.mealType]: config.fixedPortions?.toString() ?? '' }
    return { LUNCH: '' }
  })

  // Извлекаем initialCustomDays и initialInterval с type guards для JsonValue
  const cfgScheduleData = config?.scheduleData
  const isObjectData = cfgScheduleData && typeof cfgScheduleData === 'object' && !Array.isArray(cfgScheduleData)

  const initialCustomDays: number[] =
    isObjectData && 'daysOfWeek' in cfgScheduleData && Array.isArray(cfgScheduleData.daysOfWeek)
      ? cfgScheduleData.daysOfWeek.filter((d): d is number => typeof d === 'number')
      : []
  const [customDays, setCustomDays] = useState<number[]>(initialCustomDays)

  const initialInterval: string =
    isObjectData && 'intervalDays' in cfgScheduleData && typeof cfgScheduleData.intervalDays === 'number'
      ? String(cfgScheduleData.intervalDays)
      : ''
  const [intervalDays, setIntervalDays] = useState<string>(initialInterval)

  const [validFrom, setValidFrom] = useState<string>(
    config?.validFrom ? new Date(config.validFrom).toISOString().slice(0, 10) : ''
  )
  const [validTo, setValidTo] = useState<string>(
    config?.validTo ? new Date(config.validTo).toISOString().slice(0, 10) : ''
  )

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  function toggleType(mt: MealType) {
    if (isEditing) return
    setSelectedTypes((prev) => {
      const next = prev.includes(mt) ? prev.filter((x) => x !== mt) : [...prev, mt]
      // Сохраняем порядок: BREAKFAST, LUNCH, DINNER
      return MEAL_TYPES_ORDER.filter((x) => next.includes(x))
    })
  }

  function toggleCustomDay(d: number) {
    setCustomDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort())
  }

  // Предупреждение: для FIXED у нескольких типов порции должны совпадать (правило ТЗ)
  const portionsMismatch = !isEditing && orderType === 'FIXED' && selectedTypes.length > 1
    ? (() => {
        const values = selectedTypes
          .map((mt) => parseInt(portionsByType[mt] || '0', 10))
          .filter((v) => v > 0)
        if (values.length < 2) return false
        const first = values[0]
        return values.some((v) => v !== first)
      })()
    : false

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!locationId) {
      toast.error('Выберите локацию')
      return
    }

    if (selectedTypes.length === 0) {
      toast.error('Выберите хотя бы один тип питания')
      return
    }

    // Валидация цен
    for (const mt of selectedTypes) {
      const p = parseFloat(pricesByType[mt] || '')
      if (isNaN(p) || p < 0) {
        toast.error(`Укажите цену для типа "${MEAL_TYPE_LABELS[mt]}"`)
        return
      }
    }

    if (orderType === 'FIXED') {
      for (const mt of selectedTypes) {
        const v = parseInt(portionsByType[mt] || '0', 10)
        if (v <= 0) {
          toast.error(`Укажите количество порций для типа "${MEAL_TYPE_LABELS[mt]}"`)
          return
        }
      }
    }

    let scheduleData: Record<string, unknown> | null = null
    if (scheduleType === 'CUSTOM_DAYS') {
      if (customDays.length === 0) {
        toast.error('Выберите хотя бы один день недели')
        return
      }
      scheduleData = { daysOfWeek: customDays }
    } else if (scheduleType === 'INTERVAL') {
      const interval = parseInt(intervalDays, 10)
      if (!interval || interval <= 0) {
        toast.error('Укажите интервал в днях')
        return
      }
      scheduleData = { intervalDays: interval }
    }

    startTransition(async () => {
      if (isEditing && config) {
        // Редактирование одного конфига — старый action
        const mt = config.mealType
        const data = {
          // handleSubmit гарантирует !!locationId выше — пустую строку action всё равно отклонит.
          locationId,
          mealType: mt,
          orderType,
          deliveryHorizon,
          scheduleType,
          scheduleData,
          fixedPortions: orderType === 'FIXED' ? parseInt(portionsByType[mt] || '0', 10) : null,
          pricePerPortion: parseFloat(pricesByType[mt] || '0'),
          validFrom: validFrom || null,
          validTo: validTo || null,
        }
        const result = await updateMealConfig(config.id, data)
        if (result.ok) {
          toast.success('Конфиг обновлён')
          onClose()
        } else {
          toast.error(result.error)
        }
      } else {
        // Создание — bulk
        const pricesNumbers: Record<string, number> = {}
        const portionsNumbers: Record<string, number> = {}
        for (const mt of selectedTypes) {
          pricesNumbers[mt] = parseFloat(pricesByType[mt])
          if (orderType === 'FIXED') {
            portionsNumbers[mt] = parseInt(portionsByType[mt], 10)
          }
        }

        const result = await createMealConfigBulk(clientId, {
          locationId,
          mealTypes: selectedTypes,
          pricesByType: pricesNumbers,
          orderType,
          deliveryHorizon,
          scheduleType,
          scheduleData,
          fixedPortionsByType: orderType === 'FIXED' ? portionsNumbers : null,
          validFrom: validFrom || null,
          validTo: validTo || null,
        })

        if (result.ok) {
          const baseMsg = selectedTypes.length === 1
            ? 'Конфиг создан'
            : `Создано конфигов: ${selectedTypes.length}`
          if (result.data.autoGenerated > 0) {
            toast.success(`${baseMsg}. Заказы на завтра созданы: ${result.data.autoGenerated}`)
          } else {
            toast.success(baseMsg)
          }
          onClose()
        } else {
          toast.error(result.error)
        }
      }
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-fg/30 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl bg-surface border border-border" style={{ boxShadow: 'var(--shadow-popover)' }}>
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="text-lg font-semibold">{isEditing ? 'Редактировать конфиг питания' : 'Новый конфиг питания'}</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Точка <span className="text-danger-fg">*</span>
            </label>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              required
              className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors"
            >
              <option value="" disabled>Выберите локацию…</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            {!locationId && (
              <p className="text-xs text-fg-subtle">Конфиг привязывается к конкретной локации клиента.</p>
            )}
          </div>

          {/* Типы питания — чекбоксы при создании, статичный текст при редактировании */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Типы питания
              {!isEditing && <span className="text-fg-subtle font-normal"> (можно несколько)</span>}
            </label>
            {isEditing ? (
              <div className="px-3 py-2.5 rounded-xl bg-bg/50 border border-border text-sm">
                {MEAL_TYPE_LABELS[config!.mealType]}
                <span className="text-xs text-fg-subtle ml-2">(нельзя сменить при редактировании)</span>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {MEAL_TYPES_ORDER.map((mt) => (
                  <button
                    key={mt}
                    type="button"
                    onClick={() => toggleType(mt)}
                    className={cn(
                      'px-3 py-2.5 rounded-xl text-sm font-medium transition-colors border',
                      selectedTypes.includes(mt)
                        ? 'bg-accent text-accent-fg border-accent'
                        : 'bg-bg text-fg-muted border-border hover:text-fg hover:border-border-strong'
                    )}
                  >
                    {MEAL_TYPE_LABELS[mt]}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Тип заказа</label>
            <select value={orderType} onChange={(e) => setOrderType(e.target.value as OrderType)} className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors">
              <option value="FIXED">{ORDER_TYPE_LABELS.FIXED}</option>
              <option value="DYNAMIC">{ORDER_TYPE_LABELS.DYNAMIC}</option>
            </select>
          </div>

          {/* Поля цены и порций — по каждому выбранному типу */}
          {selectedTypes.map((mt) => (
            <div key={mt} className="bg-bg/40 rounded-xl p-3 space-y-3">
              <p className="text-xs uppercase tracking-wider text-fg-muted font-medium">
                {MEAL_TYPE_LABELS[mt]}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-fg-muted">Цена за порцию, ₽</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={pricesByType[mt] ?? ''}
                    onChange={(e) => setPricesByType((p) => ({ ...p, [mt]: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-surface border border-border focus:outline-none focus:border-accent transition-colors text-sm tabular-nums"
                  />
                </div>
                {orderType === 'FIXED' && (
                  <div className="space-y-1.5">
                    <label className="text-xs text-fg-muted">Количество порций</label>
                    <input
                      type="number"
                      min="1"
                      value={portionsByType[mt] ?? ''}
                      onChange={(e) => setPortionsByType((p) => ({ ...p, [mt]: e.target.value }))}
                      className="w-full px-3 py-2 rounded-lg bg-surface border border-border focus:outline-none focus:border-accent transition-colors text-sm tabular-nums"
                    />
                  </div>
                )}
              </div>
            </div>
          ))}

          {portionsMismatch && (
            <div className="rounded-xl bg-warning-bg/50 border border-warning/20 px-3 py-2.5 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warning-fg shrink-0 mt-0.5" />
              <p className="text-xs text-warning-fg">
                По правилу: количество обедов должно равняться количеству ужинов. Сейчас числа отличаются — но сохранить можно.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Доставка</label>
            <select value={deliveryHorizon} onChange={(e) => setDeliveryHorizon(e.target.value as DeliveryHorizon)} className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors">
              <option value="NEXT_DAY">{DELIVERY_HORIZON_LABELS.NEXT_DAY}</option>
              <option value="SAME_DAY">{DELIVERY_HORIZON_LABELS.SAME_DAY}</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">График</label>
            <select value={scheduleType} onChange={(e) => setScheduleType(e.target.value as ScheduleType)} className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors">
              <option value="DAILY">{SCHEDULE_TYPE_LABELS.DAILY}</option>
              <option value="WEEKDAYS">{SCHEDULE_TYPE_LABELS.WEEKDAYS}</option>
              <option value="WEEKENDS">{SCHEDULE_TYPE_LABELS.WEEKENDS}</option>
              <option value="CUSTOM_DAYS">{SCHEDULE_TYPE_LABELS.CUSTOM_DAYS}</option>
              <option value="INTERVAL">{SCHEDULE_TYPE_LABELS.INTERVAL}</option>
              <option value="ONE_TIME">{SCHEDULE_TYPE_LABELS.ONE_TIME}</option>
            </select>
          </div>

          {scheduleType === 'CUSTOM_DAYS' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Дни недели</label>
              <div className="flex gap-1.5">
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleCustomDay(d)}
                    className={cn(
                      'flex-1 px-2 py-2 rounded-lg text-sm font-medium transition-colors',
                      customDays.includes(d)
                        ? 'bg-accent text-accent-fg'
                        : 'bg-bg text-fg-muted hover:text-fg hover:bg-border'
                    )}
                  >
                    {WEEKDAY_NAMES_SHORT[d]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {scheduleType === 'INTERVAL' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Интервал в днях</label>
              <input type="number" min="1" value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} placeholder="Например, 14" className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors" />
            </div>
          )}

          {(scheduleType === 'ONE_TIME' || scheduleType === 'INTERVAL') && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Действует с</label>
                <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors" />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">До</label>
                <input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors" />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={isPending} className="px-5 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors disabled:opacity-50">
              Отмена
            </button>
            <button type="submit" disabled={isPending || !locationId} className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50">
              {isPending ? 'Сохраняем…' : isEditing ? 'Сохранить' : (selectedTypes.length > 1 ? `Создать ${selectedTypes.length} конфига` : 'Создать конфиг')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
