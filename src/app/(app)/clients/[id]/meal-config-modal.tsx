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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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

  // E-блок MEGA-AUDIT-FIX-2: подтверждение изменения fixedPortions при наличии
  // будущих DRAFT/PENDING заказов с устаревшим значением.
  const [confirmState, setConfirmState] = useState<{
    // T-2: 'portions' — старый сценарий (обновляем порции в заказах);
    // 'schedule' — только предупреждение, заказы остаются как есть.
    changeType: 'portions' | 'schedule'
    affectedOrders: number
    oldPortions: number
    newPortions: number
  } | null>(null)

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

  // E-блок MEGA-AUDIT-FIX-2: единый submit для редактирования. Принимает опциональный
  // confirmDraftPortions, чтобы повторно отправить запрос с выбором менеджера после
  // показа AlertDialog.
  async function submitUpdate(
    data: Parameters<typeof updateMealConfig>[1],
    confirm?: 'keep' | 'update'
  ) {
    if (!config) return
    const result = await updateMealConfig(config.id, {
      ...data,
      confirmDraftPortions: confirm,
    })
    if (result.ok) {
      toast.success('Питание обновлено')
      setConfirmState(null)
      onClose()
      return
    }
    if ('needsConfirmation' in result && result.needsConfirmation) {
      setConfirmState({
        changeType: result.changeType,
        affectedOrders: result.affectedOrders,
        oldPortions: result.oldPortions,
        newPortions: result.newPortions,
      })
      return
    }
    toast.error(result.error)
  }

  // Текущий data-payload для редактирования — используется и из формы, и из
  // AlertDialog (повторный submit с confirm). Считается «лениво», только если
  // мы в режиме редактирования.
  function buildEditPayload(): Parameters<typeof updateMealConfig>[1] | null {
    if (!isEditing || !config) return null
    const mt = config.mealType
    let scheduleData: Record<string, unknown> | null = null
    if (scheduleType === 'CUSTOM_DAYS') {
      scheduleData = { daysOfWeek: customDays }
    } else if (scheduleType === 'INTERVAL') {
      const interval = parseInt(intervalDays, 10)
      if (interval > 0) scheduleData = { intervalDays: interval }
    }
    return {
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
  }

  function handleConfirmChoice(confirm: 'keep' | 'update') {
    const payload = buildEditPayload()
    if (!payload) return
    startTransition(async () => {
      await submitUpdate(payload, confirm)
    })
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
        await submitUpdate(data)
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
            ? 'Питание создано'
            : `Создано: ${selectedTypes.length}`
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
    <>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-fg/30 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl bg-surface border border-border" style={{ boxShadow: 'var(--shadow-popover)' }}>
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-display text-lg font-bold text-fg-strong">{isEditing ? 'Редактировать питание' : 'Новое питание'}</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть" style={{ touchAction: 'manipulation' }} className="min-h-[44px] min-w-[44px] w-11 h-11 -mr-2 rounded-full hover:bg-surface-2 flex items-center justify-center text-fg-muted hover:text-fg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">
              Точка <span className="text-danger-fg">*</span>
            </label>
            <Select value={locationId || undefined} onValueChange={(v) => setLocationId(v)}>
              <SelectTrigger aria-required="true" className="w-full !h-auto min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border-border focus-visible:border-brand-green focus-visible:ring-1 focus-visible:ring-brand-green/30 transition-colors data-placeholder:text-fg-muted">
                <SelectValue placeholder="Выберите локацию…" />
              </SelectTrigger>
              <SelectContent>
                {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {!locationId && (
              <p className="text-xs text-fg-subtle">Питание привязывается к конкретной локации клиента.</p>
            )}
          </div>

          {/* Типы питания — чекбоксы при создании, статичный текст при редактировании */}
          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">
              Типы питания
              {!isEditing && <span className="text-fg-subtle font-normal normal-case tracking-normal"> (можно несколько)</span>}
            </label>
            {isEditing ? (
              <div className="min-h-[44px] flex items-center px-3 py-2.5 rounded-xl bg-surface-2 border border-border text-sm">
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
                    aria-pressed={selectedTypes.includes(mt)}
                    style={{ touchAction: 'manipulation' }}
                    className={cn(
                      'min-h-[44px] px-3 py-2.5 rounded-xl text-sm font-medium transition-colors border',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                      selectedTypes.includes(mt)
                        ? 'bg-brand-green text-white border-brand-green'
                        : 'bg-surface text-fg-muted border-border hover:text-fg hover:border-border-strong'
                    )}
                  >
                    {MEAL_TYPE_LABELS[mt]}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Тип заказа</label>
            <Select value={orderType} onValueChange={(v) => setOrderType(v as OrderType)}>
              <SelectTrigger className="w-full !h-auto min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border-border focus-visible:border-brand-green focus-visible:ring-1 focus-visible:ring-brand-green/30 transition-colors data-placeholder:text-fg-muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="FIXED">{ORDER_TYPE_LABELS.FIXED}</SelectItem>
                <SelectItem value="DYNAMIC">{ORDER_TYPE_LABELS.DYNAMIC}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Поля цены и порций — по каждому выбранному типу */}
          {selectedTypes.map((mt) => (
            <div key={mt} className="bg-surface-2 rounded-xl p-4 mb-4 space-y-3">
              <p className="font-display text-xs font-bold uppercase tracking-wider text-fg-muted">
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
                    className="w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors text-sm tabular-nums"
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
                      className="w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors text-sm tabular-nums"
                    />
                  </div>
                )}
              </div>
            </div>
          ))}

          {portionsMismatch && (
            <div className="rounded-xl bg-warning-bg border border-warning/30 px-3 py-2.5 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warning-fg shrink-0 mt-0.5" />
              <p className="text-xs text-warning-fg">
                По правилу: количество обедов должно равняться количеству ужинов. Сейчас числа отличаются — но сохранить можно.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Доставка</label>
            <Select value={deliveryHorizon} onValueChange={(v) => setDeliveryHorizon(v as DeliveryHorizon)}>
              <SelectTrigger className="w-full !h-auto min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border-border focus-visible:border-brand-green focus-visible:ring-1 focus-visible:ring-brand-green/30 transition-colors data-placeholder:text-fg-muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NEXT_DAY">{DELIVERY_HORIZON_LABELS.NEXT_DAY}</SelectItem>
                <SelectItem value="SAME_DAY">{DELIVERY_HORIZON_LABELS.SAME_DAY}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">График</label>
            <Select value={scheduleType} onValueChange={(v) => setScheduleType(v as ScheduleType)}>
              <SelectTrigger className="w-full !h-auto min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border-border focus-visible:border-brand-green focus-visible:ring-1 focus-visible:ring-brand-green/30 transition-colors data-placeholder:text-fg-muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DAILY">{SCHEDULE_TYPE_LABELS.DAILY}</SelectItem>
                <SelectItem value="WEEKDAYS">{SCHEDULE_TYPE_LABELS.WEEKDAYS}</SelectItem>
                <SelectItem value="WEEKENDS">{SCHEDULE_TYPE_LABELS.WEEKENDS}</SelectItem>
                <SelectItem value="CUSTOM_DAYS">{SCHEDULE_TYPE_LABELS.CUSTOM_DAYS}</SelectItem>
                <SelectItem value="INTERVAL">{SCHEDULE_TYPE_LABELS.INTERVAL}</SelectItem>
                <SelectItem value="ONE_TIME">{SCHEDULE_TYPE_LABELS.ONE_TIME}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {scheduleType === 'CUSTOM_DAYS' && (
            <div className="space-y-1.5">
              <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Дни недели</label>
              <div className="flex gap-1.5">
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleCustomDay(d)}
                    aria-pressed={customDays.includes(d)}
                    style={{ touchAction: 'manipulation' }}
                    className={cn(
                      'flex-1 min-h-[44px] px-2 py-2 rounded-lg text-sm font-medium transition-colors border',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                      customDays.includes(d)
                        ? 'bg-brand-green-deep text-white border-brand-green-deep'
                        : 'bg-surface text-fg-muted border-border hover:text-fg hover:border-border-strong'
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
              <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Интервал в днях</label>
              <input type="number" min="1" value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} placeholder="Например, 14" className="w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors tabular-nums" />
            </div>
          )}

          {(scheduleType === 'ONE_TIME' || scheduleType === 'INTERVAL') && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Действует с</label>
                <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} className="w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors tabular-nums" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">До</label>
                <input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} className="w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors tabular-nums" />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={isPending} style={{ touchAction: 'manipulation' }} className="min-h-[44px] px-5 py-2.5 rounded-xl border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-surface-2 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
              Отмена
            </button>
            <button type="submit" disabled={isPending || !locationId} style={{ touchAction: 'manipulation', background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' }} className="min-h-[44px] px-5 py-2.5 rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
              {isPending ? 'Сохраняем…' : isEditing ? 'Сохранить' : (selectedTypes.length > 1 ? `Создать (${selectedTypes.length})` : 'Создать питание')}
            </button>
          </div>
        </form>
      </div>
    </div>

    {/* E-блок MEGA-AUDIT-FIX-2: подтверждение изменения fixedPortions.
        T-2: смена расписания у FIXED — отдельный текст-предупреждение. */}
    <AlertDialog
      open={confirmState !== null}
      onOpenChange={(o) => { if (!o) setConfirmState(null) }}
    >
      <AlertDialogContent>
        {confirmState?.changeType === 'schedule' ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display text-warning-fg">Расписание изменено</AlertDialogTitle>
              <AlertDialogDescription className="text-fg-muted">
                {confirmState.affectedOrders} будущих заказов могут не
                соответствовать новому графику. Проверьте список заказов вручную
                и отмените лишние при необходимости.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogAction
                disabled={isPending}
                onClick={() => handleConfirmChoice('update')}
              >
                Понятно
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display text-warning-fg">Обновить порции в будущих заказах?</AlertDialogTitle>
              <AlertDialogDescription className="text-fg-muted">
                {confirmState && (
                  <>
                    У этого конфига {confirmState.affectedOrders} будущих DRAFT/PENDING
                    заказов с {confirmState.oldPortions} порций. Поменять порции в
                    заказах на {confirmState.newPortions} или оставить старые значения?
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={isPending}
                onClick={() => handleConfirmChoice('keep')}
              >
                Только конфиг
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={isPending}
                onClick={() => handleConfirmChoice('update')}
              >
                {confirmState ? `Обновить ${confirmState.affectedOrders} заказов` : 'Обновить заказы'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
