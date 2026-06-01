'use client'

import { useState, useTransition, useEffect } from 'react'
import { X, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { createLocation, updateLocation } from '../actions'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ClientLocation } from '@prisma/client'

interface Props {
  clientId: string
  location?: ClientLocation
  open: boolean
  onClose: () => void
}

export function LocationModal({ clientId, location, open, onClose }: Props) {
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState(location?.name ?? '')
  const [address, setAddress] = useState(location?.address ?? '')
  const [from, setFrom] = useState(location?.deliveryWindowFrom ?? '')
  const [to, setTo] = useState(location?.deliveryWindowTo ?? '')
  const [packaging, setPackaging] = useState<'INDIVIDUAL' | 'BULK'>(location?.packaging ?? 'INDIVIDUAL')
  const [tags, setTags] = useState<string[]>(location?.tags ?? [])
  const [tagInput, setTagInput] = useState('')
  const [sameDayDelivery, setSameDayDelivery] = useState<boolean>(location?.sameDayDelivery ?? false)
  const [cutoffHourMsk, setCutoffHourMsk] = useState<number | ''>(location?.cutoffHourMsk ?? '')
  const [cutoffMinuteMsk, setCutoffMinuteMsk] = useState<number | ''>(location?.cutoffMinuteMsk ?? '')

  useEffect(() => {
    if (open && !location) {
      setName('')
      setAddress('')
      setFrom('')
      setTo('')
      setPackaging('INDIVIDUAL')
      setTags([])
      setTagInput('')
      setSameDayDelivery(false)
      setCutoffHourMsk('')
      setCutoffMinuteMsk('')
    } else if (open && location) {
      setName(location.name)
      setAddress(location.address)
      setFrom(location.deliveryWindowFrom ?? '')
      setTo(location.deliveryWindowTo ?? '')
      setPackaging(location.packaging)
      setTags(location.tags)
      setSameDayDelivery(location.sameDayDelivery ?? false)
      setCutoffHourMsk(location.cutoffHourMsk ?? '')
      setCutoffMinuteMsk(location.cutoffMinuteMsk ?? '')
    }
  }, [open, location])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  function addTag() {
    const t = tagInput.trim()
    if (t && !tags.includes(t)) {
      setTags([...tags, t])
      setTagInput('')
    }
  }

  function removeTag(t: string) {
    setTags(tags.filter((x) => x !== t))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !address.trim()) {
      toast.error('Заполните название и адрес')
      return
    }

    startTransition(async () => {
      const data = {
        name: name.trim(),
        address: address.trim(),
        deliveryWindowFrom: from || null,
        deliveryWindowTo: to || null,
        packaging,
        tags,
        sameDayDelivery,
        cutoffHourMsk: cutoffHourMsk === '' ? null : cutoffHourMsk,
        cutoffMinuteMsk: cutoffMinuteMsk === '' ? null : cutoffMinuteMsk,
      }

      const result = location
        ? await updateLocation(location.id, data)
        : await createLocation(clientId, data)

      if (result.ok) {
        toast.success(location ? 'Точка обновлена' : 'Точка создана')
        onClose()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-fg/30 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-surface border border-border" style={{ boxShadow: 'var(--shadow-popover)' }}>
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-display text-lg font-bold text-fg-strong">{location ? 'Редактировать точку' : 'Новая точка'}</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть" style={{ touchAction: 'manipulation' }} className="min-h-[44px] min-w-[44px] w-11 h-11 -mr-2 rounded-full hover:bg-surface-2 flex items-center justify-center text-fg-muted hover:text-fg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Название точки</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus className="w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors" />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Адрес</label>
            <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} className="w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Окно с</label>
              <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors tabular-nums" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Окно до</label>
              <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className="w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors tabular-nums" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Упаковка</label>
              <Select value={packaging} onValueChange={(v) => setPackaging(v as 'INDIVIDUAL' | 'BULK')}>
                <SelectTrigger className="w-full !h-auto min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border-border focus-visible:border-brand-green focus-visible:ring-1 focus-visible:ring-brand-green/30 transition-colors data-placeholder:text-fg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="INDIVIDUAL">Порционно</SelectItem>
                  <SelectItem value="BULK">Коробками</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={sameDayDelivery}
                onChange={(e) => setSameDayDelivery(e.target.checked)}
                className="w-4 h-4 rounded border-border accent-brand-green"
              />
              <span className="text-sm font-medium text-fg">Заказ день-в-день</span>
              <span
                aria-label="Подсказка"
                title="Для клиентов которые узнают количество людей утром (например в 8:00) и доставка идёт в этот же день. При включении заказы создаются на сегодня, не на завтра. Вопрос клиенту шлётся в 07:40 МСК, индивидуальный cut-off настраивается ниже."
                className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-surface-2 text-fg-muted text-[10px] font-bold cursor-help"
              >
                ⓘ
              </span>
            </label>
            {sameDayDelivery && (
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div className="space-y-1.5">
                  <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Cut-off час (МСК)</label>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    placeholder="8"
                    value={cutoffHourMsk}
                    onChange={(e) => setCutoffHourMsk(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors tabular-nums"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Cut-off минута</label>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    placeholder="40"
                    value={cutoffMinuteMsk}
                    onChange={(e) => setCutoffMinuteMsk(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors tabular-nums"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">Пометки</label>
            <p className="text-xs text-fg-subtle">Например: «Прораб — аллергия на цитрус», «Без лука»</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
                placeholder="Добавить пометку и нажать Enter"
                className="flex-1 min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors text-sm"
              />
              <button type="button" onClick={addTag} aria-label="Добавить пометку" style={{ touchAction: 'manipulation' }} className="min-h-[44px] min-w-[44px] px-3 rounded-xl bg-surface-2 hover:bg-border text-fg-muted hover:text-fg text-sm transition-colors flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
                <Plus className="w-4 h-4" />
              </button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-2">
                {tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-pill bg-warning-bg text-warning-fg text-xs font-medium">
                    {t}
                    <button type="button" onClick={() => removeTag(t)} aria-label={`Убрать ${t}`} className="rounded-full hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={isPending} style={{ touchAction: 'manipulation' }} className="min-h-[44px] px-5 py-2.5 rounded-xl border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-surface-2 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
              Отмена
            </button>
            <button type="submit" disabled={isPending} style={{ touchAction: 'manipulation', background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' }} className="min-h-[44px] px-5 py-2.5 rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
              {isPending ? 'Сохраняем…' : location ? 'Сохранить' : 'Создать'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
