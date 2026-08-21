'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import {
  Crosshair,
  Link2,
  LoaderCircle,
  MapPinned,
  Plus,
  ShieldCheck,
  Truck,
  UserRound,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  createLocation,
  updateLocation,
  type LocationFormData,
} from '../actions'
import { PhoneInput } from '@/components/ui/phone-input'
import { Switch } from '@/components/ui/switch'
import { isValidPhone } from '@/lib/utils/format'
import {
  areValidCoordinates,
  parseYandexCoordinates,
} from '@/lib/delivery/yandex-coordinates'
import {
  DELIVERY_MODE_LABELS,
  parseCoordinateInput,
  resolveLocationDeliveryMode,
  type LocationDeliveryMode,
  type SerializedLocation,
} from './location-types'

interface Props {
  clientId: string
  location?: SerializedLocation
  couriers: Array<{ id: string; name: string }>
  open: boolean
  onClose: () => void
}

const INPUT_CLASS =
  'w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border text-fg placeholder:text-fg-subtle focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors [touch-action:manipulation]'
const SECTION_CLASS = 'rounded-2xl border border-border bg-bg p-4 space-y-4'
const SECTION_TITLE_CLASS =
  'font-display text-sm font-bold uppercase tracking-wide text-fg-strong'

function coordinateValue(value: number | null | undefined): string {
  return value == null ? '' : String(value)
}

function geolocationErrorMessage(error: GeolocationPositionError): string {
  if (error.code === 1) return 'Доступ к геопозиции запрещён в браузере.'
  if (error.code === 2) return 'Не удалось определить геопозицию устройства.'
  if (error.code === 3) return 'Определение геопозиции заняло слишком много времени.'
  return 'Не удалось получить геопозицию.'
}

export function LocationModal({ clientId, location, couriers, open, onClose }: Props) {
  const [isPending, startTransition] = useTransition()
  const [isLocating, setIsLocating] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [packaging, setPackaging] = useState<'INDIVIDUAL' | 'BULK'>('INDIVIDUAL')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [sameDayDelivery, setSameDayDelivery] = useState(false)
  const [cutoffTimeStr, setCutoffTimeStr] = useState('')
  const [deliveryFee, setDeliveryFee] = useState('')

  const [defaultDeliveryMode, setDefaultDeliveryMode] =
    useState<LocationDeliveryMode>('EXTERNAL')
  const [assignedCourierId, setAssignedCourierId] = useState('')
  const [deliveryInstructions, setDeliveryInstructions] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactNotes, setContactNotes] = useState('')

  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [coordinatesSource, setCoordinatesSource] = useState<string | null>(null)
  const [yandexUrl, setYandexUrl] = useState('')
  const [geofenceEnabled, setGeofenceEnabled] = useState(false)
  const [geofenceRadiusM, setGeofenceRadiusM] = useState('1000')

  const [formError, setFormError] = useState<string | null>(null)
  const [coordinateMessage, setCoordinateMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return

    const primaryContact = location?.deliveryContacts.find(
      (contact) => contact.isPrimaryForDelivery,
    )
    setName(location?.name ?? '')
    setAddress(location?.address ?? '')
    setFrom(location?.deliveryWindowFrom ?? '')
    setTo(location?.deliveryWindowTo ?? '')
    setPackaging(location?.packaging ?? 'INDIVIDUAL')
    setTags(location?.tags ?? [])
    setTagInput('')
    setSameDayDelivery(location?.sameDayDelivery ?? false)
    setCutoffTimeStr(
      location?.cutoffHourMsk != null
        ? `${String(location.cutoffHourMsk).padStart(2, '0')}:${String(
            location.cutoffMinuteMsk ?? 0,
          ).padStart(2, '0')}`
        : '',
    )
    setDeliveryFee(coordinateValue(location?.deliveryFee))

    setDefaultDeliveryMode(
      resolveLocationDeliveryMode(
        location?.defaultDeliveryMode,
        location?.assignedCourierId,
      ),
    )
    setAssignedCourierId(location?.assignedCourierId ?? '')
    setDeliveryInstructions(location?.deliveryInstructions ?? '')
    setContactName(primaryContact?.name ?? '')
    setContactPhone(primaryContact?.phone ?? '')
    setContactNotes(primaryContact?.notes ?? '')

    setLatitude(coordinateValue(location?.latitude))
    setLongitude(coordinateValue(location?.longitude))
    setCoordinatesSource(location?.coordinatesSource ?? null)
    setYandexUrl('')
    setGeofenceEnabled(location?.geofenceEnabled ?? false)
    setGeofenceRadiusM(String(location?.geofenceRadiusM ?? 1000))
    setFormError(null)
    setCoordinateMessage(null)
    setIsLocating(false)
  }, [open, location])

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return

    if (!dialog.open) dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [open])

  if (!open) return null

  function addTag() {
    const tag = tagInput.trim()
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag])
      setTagInput('')
    }
  }

  function removeTag(tag: string) {
    setTags(tags.filter((item) => item !== tag))
  }

  function changeMode(mode: LocationDeliveryMode) {
    setDefaultDeliveryMode(mode)
    if (mode !== 'IN_HOUSE') setAssignedCourierId('')
  }

  function changeManualLatitude(value: string) {
    setLatitude(value)
    setCoordinatesSource('MANUAL')
    setCoordinateMessage(null)
  }

  function changeManualLongitude(value: string) {
    setLongitude(value)
    setCoordinatesSource('MANUAL')
    setCoordinateMessage(null)
  }

  function applyYandexUrl() {
    const result = parseYandexCoordinates(yandexUrl)
    if (!result.ok) {
      setCoordinateMessage(result.error.message)
      return
    }

    setLatitude(String(result.coordinates.latitude))
    setLongitude(String(result.coordinates.longitude))
    setCoordinatesSource('YANDEX_URL')
    setCoordinateMessage('Координаты взяты из ссылки Яндекс.Карт.')
  }

  function useDeviceLocation() {
    if (!('geolocation' in navigator)) {
      setCoordinateMessage('Этот браузер не поддерживает геопозицию.')
      return
    }

    setIsLocating(true)
    setCoordinateMessage('Определяем позицию этого устройства…')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextLatitude = position.coords.latitude
        const nextLongitude = position.coords.longitude
        if (!areValidCoordinates(nextLatitude, nextLongitude)) {
          setCoordinateMessage('Браузер вернул некорректные координаты.')
          setIsLocating(false)
          return
        }

        setLatitude(String(nextLatitude))
        setLongitude(String(nextLongitude))
        setCoordinatesSource('BROWSER_GEOLOCATION')
        setCoordinateMessage('Геопозиция устройства сохранена в форме.')
        setIsLocating(false)
      },
      (error) => {
        setCoordinateMessage(geolocationErrorMessage(error))
        setIsLocating(false)
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
    )
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)

    if (!name.trim() || !address.trim()) {
      setFormError('Заполните название и адрес.')
      return
    }
    if (defaultDeliveryMode === 'IN_HOUSE' && !assignedCourierId) {
      setFormError('Для своего курьера выберите сотрудника.')
      return
    }

    const hasContactData = Boolean(
      contactName.trim() || contactPhone.trim() || contactNotes.trim(),
    )
    if (hasContactData && !isValidPhone(contactPhone)) {
      setFormError('Телефон доставки должен быть в формате +7 (999) 999-99-99.')
      return
    }

    const parsedLatitude = parseCoordinateInput(latitude)
    const parsedLongitude = parseCoordinateInput(longitude)
    if (!parsedLatitude.ok || !parsedLongitude.ok) {
      setFormError('Проверьте формат широты и долготы.')
      return
    }
    const latitudeValue = parsedLatitude.value
    const longitudeValue = parsedLongitude.value
    if ((latitudeValue === null) !== (longitudeValue === null)) {
      setFormError('Широта и долгота заполняются вместе.')
      return
    }
    if (
      latitudeValue !== null &&
      longitudeValue !== null &&
      !areValidCoordinates(latitudeValue, longitudeValue)
    ) {
      setFormError('Координаты находятся вне допустимого диапазона.')
      return
    }

    const radius = Number(geofenceRadiusM)
    if (!Number.isInteger(radius) || radius < 100 || radius > 5000) {
      setFormError('Радиус геозоны должен быть целым числом от 100 до 5000 м.')
      return
    }
    if (geofenceEnabled && latitudeValue === null) {
      setFormError('Для включения геозоны сначала укажите координаты.')
      return
    }

    const fee = deliveryFee.trim() === '' ? null : Number(deliveryFee)
    if (fee !== null && (!Number.isFinite(fee) || fee < 0)) {
      setFormError('Проверьте стоимость доставки.')
      return
    }

    let cutoffHourMsk: number | null = null
    let cutoffMinuteMsk: number | null = null
    if (cutoffTimeStr !== '') {
      const [hours, minutes] = cutoffTimeStr.split(':')
      cutoffHourMsk = Number(hours)
      cutoffMinuteMsk = Number(minutes)
    }

    const data = {
      name: name.trim(),
      address: address.trim(),
      deliveryWindowFrom: from || null,
      deliveryWindowTo: to || null,
      packaging,
      tags,
      sameDayDelivery,
      cutoffHourMsk,
      cutoffMinuteMsk,
      deliveryFee: fee,
      defaultDeliveryMode,
      assignedCourierId:
        defaultDeliveryMode === 'IN_HOUSE' ? assignedCourierId : null,
      deliveryInstructions: deliveryInstructions.trim() || null,
      deliveryContact: hasContactData
        ? {
            name: contactName.trim() || null,
            phone: contactPhone.trim(),
            notes: contactNotes.trim() || null,
          }
        : null,
      latitude: latitudeValue,
      longitude: longitudeValue,
      geofenceRadiusM: radius,
      geofenceEnabled,
      coordinatesSource:
        latitudeValue === null ? null : coordinatesSource ?? 'MANUAL',
    } satisfies LocationFormData

    startTransition(async () => {
      const result = location
        ? await updateLocation(location.id, data)
        : await createLocation(clientId, data)

      if (result.ok) {
        toast.success(location ? 'Точка обновлена' : 'Точка создана')
        onClose()
      } else {
        setFormError(result.error)
        toast.error(result.error)
      }
    })
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="location-modal-title"
      className="fixed inset-0 z-50 m-0 hidden h-dvh w-full max-w-none items-center justify-center border-0 bg-transparent p-3 backdrop:bg-fg/40 open:flex sm:p-5"
      onCancel={(event) => {
        event.preventDefault()
        if (!isPending) onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !isPending) onClose()
      }}
    >
      <div
        className="w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-2xl bg-surface border border-border"
        style={{ boxShadow: 'var(--shadow-popover)' }}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between p-5 border-b border-border bg-surface">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-fg-subtle">Точка клиента</p>
            <h2 id="location-modal-title" className="font-display text-xl font-bold text-fg-strong">
              {location ? 'Редактировать точку' : 'Новая точка'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            aria-label="Закрыть"
            className="min-h-[44px] min-w-[44px] w-11 h-11 -mr-2 rounded-full hover:bg-surface-2 flex items-center justify-center text-fg-muted hover:text-fg transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 [touch-action:manipulation]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 sm:p-5 space-y-5">
          <fieldset className={SECTION_CLASS}>
            <legend className={`${SECTION_TITLE_CLASS} px-1`}>Основное</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Название точки" htmlFor="location-name">
                <input
                  id="location-name"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoFocus
                  required
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Адрес" htmlFor="location-address">
                <input
                  id="location-address"
                  type="text"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  required
                  className={INPUT_CLASS}
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Окно с" htmlFor="location-window-from">
                <input id="location-window-from" type="time" value={from} onChange={(event) => setFrom(event.target.value)} className={`${INPUT_CLASS} tabular-nums`} />
              </Field>
              <Field label="Окно до" htmlFor="location-window-to">
                <input id="location-window-to" type="time" value={to} onChange={(event) => setTo(event.target.value)} className={`${INPUT_CLASS} tabular-nums`} />
              </Field>
              <Field label="Упаковка" htmlFor="location-packaging">
                <select
                  id="location-packaging"
                  value={packaging}
                  onChange={(event) => setPackaging(event.target.value as 'INDIVIDUAL' | 'BULK')}
                  className={INPUT_CLASS}
                >
                  <option value="INDIVIDUAL">Порционно</option>
                  <option value="BULK">Коробками</option>
                </select>
              </Field>
            </div>

            <label className="flex items-start gap-3 min-h-[44px] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={sameDayDelivery}
                onChange={(event) => setSameDayDelivery(event.target.checked)}
                className="mt-1 w-4 h-4 rounded border-border accent-brand-green"
              />
              <span>
                <span className="block text-sm font-medium text-fg">Заказ день-в-день</span>
                <span className="block text-xs text-fg-muted">Вопрос клиенту отправляется утром, заказ создаётся на сегодня.</span>
              </span>
            </label>
            {sameDayDelivery && (
              <Field label="Время приёма заявок (МСК)" htmlFor="location-cutoff">
                <input id="location-cutoff" type="time" value={cutoffTimeStr} onChange={(event) => setCutoffTimeStr(event.target.value)} className={`${INPUT_CLASS} tabular-nums`} />
              </Field>
            )}
          </fieldset>

          <fieldset className={SECTION_CLASS}>
            <legend className={`${SECTION_TITLE_CLASS} px-1`}>Доставка</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Режим доставки" htmlFor="location-delivery-mode">
                <select
                  id="location-delivery-mode"
                  value={defaultDeliveryMode}
                  onChange={(event) => changeMode(event.target.value as LocationDeliveryMode)}
                  className={INPUT_CLASS}
                >
                  {(Object.keys(DELIVERY_MODE_LABELS) as LocationDeliveryMode[]).map((mode) => (
                    <option key={mode} value={mode}>{DELIVERY_MODE_LABELS[mode]}</option>
                  ))}
                </select>
              </Field>
              {defaultDeliveryMode === 'IN_HOUSE' && (
                <Field label="Наш курьер" htmlFor="location-assigned-courier">
                  <select
                    id="location-assigned-courier"
                    value={assignedCourierId}
                    onChange={(event) => setAssignedCourierId(event.target.value)}
                    className={INPUT_CLASS}
                  >
                    <option value="">Выберите курьера</option>
                    {couriers.map((courier) => (
                      <option key={courier.id} value={courier.id}>{courier.name}</option>
                    ))}
                  </select>
                </Field>
              )}
            </div>

            <Field label="Инструкции курьеру" htmlFor="delivery-instructions" hint="Подъезд, пропуск, этаж, кому позвонить и где оставить заказ.">
              <textarea
                id="delivery-instructions"
                value={deliveryInstructions}
                onChange={(event) => setDeliveryInstructions(event.target.value)}
                maxLength={2000}
                rows={3}
                className={`${INPUT_CLASS} resize-y`}
              />
            </Field>

            <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
              <div className="flex items-center gap-2">
                <UserRound className="w-4 h-4 text-fg-subtle" />
                <h3 className="font-display text-sm font-bold text-fg-strong">Контакт на доставку</h3>
              </div>
              <p className="text-xs text-fg-muted">Отдельный основной контакт этой точки. Если оставить пустым, используется общий контакт клиента.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Имя" htmlFor="delivery-contact-name">
                  <input id="delivery-contact-name" type="text" value={contactName} onChange={(event) => setContactName(event.target.value)} maxLength={100} className={INPUT_CLASS} />
                </Field>
                <Field label="Телефон" htmlFor="delivery-contact-phone">
                  <PhoneInput id="delivery-contact-phone" value={contactPhone} onChange={setContactPhone} className="min-h-[44px] bg-surface focus:border-brand-green focus:ring-1 focus:ring-brand-green/30" />
                </Field>
              </div>
              <Field label="Заметка для курьера" htmlFor="delivery-contact-notes">
                <textarea id="delivery-contact-notes" value={contactNotes} onChange={(event) => setContactNotes(event.target.value)} maxLength={2000} rows={2} className={`${INPUT_CLASS} resize-y`} />
              </Field>
            </div>
          </fieldset>

          <fieldset className={SECTION_CLASS}>
            <legend className={`${SECTION_TITLE_CLASS} px-1`}>Координаты и геозона</legend>
            <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
              <div className="flex items-center gap-2">
                <MapPinned className="w-4 h-4 text-fg-subtle" />
                <h3 className="font-display text-sm font-bold text-fg-strong">Ссылка Яндекс.Карт</h3>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="url"
                  aria-label="Полная ссылка Яндекс.Карт"
                  value={yandexUrl}
                  onChange={(event) => setYandexUrl(event.target.value)}
                  placeholder="https://yandex.ru/maps/…?ll=37.61%2C55.75"
                  className={`${INPUT_CLASS} flex-1`}
                />
                <button
                  type="button"
                  onClick={applyYandexUrl}
                  disabled={!yandexUrl.trim()}
                  className="min-h-[44px] px-4 rounded-xl border border-border-strong bg-surface text-fg text-sm font-medium hover:bg-surface-2 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [touch-action:manipulation] inline-flex items-center justify-center gap-2"
                >
                  <Link2 className="w-4 h-4" />
                  Взять координаты
                </button>
              </div>
              <p className="text-xs text-fg-muted">Короткие ссылки нужно сначала открыть и скопировать из адресной строки. Переходы по ссылкам CRM не выполняет.</p>
            </div>

            <button
              type="button"
              onClick={useDeviceLocation}
              disabled={isLocating}
              className="min-h-[44px] px-4 rounded-xl border border-border-strong bg-surface text-fg text-sm font-medium hover:bg-surface-2 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [touch-action:manipulation] inline-flex items-center justify-center gap-2"
            >
              {isLocating ? <LoaderCircle className="w-4 h-4 animate-spin motion-reduce:animate-none" /> : <Crosshair className="w-4 h-4" />}
              {isLocating ? 'Определяем…' : 'Взять мою позицию'}
            </button>

            <p aria-live="polite" className="min-h-5 text-sm text-fg-muted">
              {coordinateMessage ?? (
                latitude.trim() && longitude.trim()
                  ? geofenceEnabled
                    ? 'Координаты настроены · геозона включена.'
                    : 'Координаты настроены · геозона выключена.'
                  : 'Геозона не настроена.'
              )}
            </p>

            <details className="rounded-xl border border-border bg-surface">
              <summary className="min-h-[44px] cursor-pointer px-4 py-3 text-sm font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                Точные координаты вручную
              </summary>
              <div className="grid grid-cols-1 gap-3 border-t border-border px-4 pb-4 pt-3 sm:grid-cols-2">
                <Field label="Широта" htmlFor="location-latitude">
                  <input id="location-latitude" inputMode="decimal" value={latitude} onChange={(event) => changeManualLatitude(event.target.value)} placeholder="55.7558000" className={`${INPUT_CLASS} tabular-nums`} />
                </Field>
                <Field label="Долгота" htmlFor="location-longitude">
                  <input id="location-longitude" inputMode="decimal" value={longitude} onChange={(event) => changeManualLongitude(event.target.value)} placeholder="37.6173000" className={`${INPUT_CLASS} tabular-nums`} />
                </Field>
              </div>
            </details>

            <div className="rounded-xl border border-border bg-surface p-4 space-y-4">
              <label className="flex items-center justify-between gap-4 min-h-[44px] cursor-pointer">
                <span className="flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 mt-0.5 text-fg-subtle shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-fg">Контроль геозоны</span>
                    <span className="block text-xs text-fg-muted">Проверять прибытие курьера рядом с точкой.</span>
                  </span>
                </span>
                <Switch checked={geofenceEnabled} onCheckedChange={setGeofenceEnabled} aria-label="Контроль геозоны" />
              </label>
              {geofenceEnabled && (
                <Field label="Радиус, м" htmlFor="geofence-radius" hint="Допустимый диапазон: 100–5000 м.">
                  <input id="geofence-radius" type="number" inputMode="numeric" min={100} max={5000} step={50} value={geofenceRadiusM} onChange={(event) => setGeofenceRadiusM(event.target.value)} className={`${INPUT_CLASS} tabular-nums`} />
                </Field>
              )}
            </div>
          </fieldset>

          <fieldset className={SECTION_CLASS}>
            <legend className={`${SECTION_TITLE_CLASS} px-1`}>Дополнительно</legend>
            <Field label="Пометки" htmlFor="location-tag" hint="Например: «аллергия на цитрус», «без лука».">
              <div className="flex gap-2">
                <input
                  id="location-tag"
                  type="text"
                  value={tagInput}
                  onChange={(event) => setTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addTag()
                    }
                  }}
                  placeholder="Добавить пометку"
                  className={`${INPUT_CLASS} flex-1`}
                />
                <button type="button" onClick={addTag} aria-label="Добавить пометку" className="min-h-[44px] min-w-[44px] px-3 rounded-xl bg-surface-2 hover:bg-border text-fg-muted hover:text-fg transition-colors flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [touch-action:manipulation]">
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </Field>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-pill bg-warning-bg text-warning-fg text-xs font-medium">
                    {tag}
                    <button type="button" onClick={() => removeTag(tag)} aria-label={`Убрать ${tag}`} className="-my-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <Field label="Стоимость доставки, ₽" htmlFor="location-delivery-fee" hint="Если пусто — доставка бесплатная.">
              <input id="location-delivery-fee" type="number" min={0} step="0.01" value={deliveryFee} onChange={(event) => setDeliveryFee(event.target.value)} placeholder="Например, 500" className={`${INPUT_CLASS} tabular-nums`} />
            </Field>
          </fieldset>

          <p role="alert" aria-live="polite" className="min-h-5 text-sm font-medium text-danger-fg">
            {formError}
          </p>

          <div className="sticky bottom-0 -mx-4 sm:-mx-5 -mb-4 sm:-mb-5 px-4 sm:px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-border bg-surface flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" onClick={onClose} disabled={isPending} className="min-h-[44px] px-5 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-surface-2 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [touch-action:manipulation]">
              Отмена
            </button>
            <button type="submit" disabled={isPending || isLocating} className="min-h-[44px] px-5 py-2.5 rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [touch-action:manipulation] inline-flex items-center justify-center gap-2 shadow-[var(--shadow-capsule)]">
              {isPending ? <LoaderCircle className="w-4 h-4 animate-spin motion-reduce:animate-none" /> : <Truck className="w-4 h-4" />}
              {isPending ? 'Сохраняем…' : location ? 'Сохранить точку' : 'Создать точку'}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-xs uppercase tracking-wide font-bold text-fg-muted">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-fg-muted">{hint}</p>}
    </div>
  )
}
