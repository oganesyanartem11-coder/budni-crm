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

  useEffect(() => {
    if (open && !location) {
      setName('')
      setAddress('')
      setFrom('')
      setTo('')
      setPackaging('INDIVIDUAL')
      setTags([])
      setTagInput('')
    } else if (open && location) {
      setName(location.name)
      setAddress(location.address)
      setFrom(location.deliveryWindowFrom ?? '')
      setTo(location.deliveryWindowTo ?? '')
      setPackaging(location.packaging)
      setTags(location.tags)
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
          <h2 className="text-lg font-semibold">{location ? 'Редактировать точку' : 'Новая точка'}</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Название точки</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors" />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Адрес</label>
            <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Окно с</label>
              <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Окно до</label>
              <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Упаковка</label>
              <Select value={packaging} onValueChange={(v) => setPackaging(v as 'INDIVIDUAL' | 'BULK')}>
                <SelectTrigger className="w-full !h-auto px-3 py-2.5 rounded-xl bg-bg border-border focus-visible:border-accent focus-visible:ring-0 transition-colors data-placeholder:text-fg-muted">
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
            <label className="text-sm font-medium">Пометки</label>
            <p className="text-xs text-fg-subtle">Например: «Прораб — аллергия на цитрус», «Без лука»</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
                placeholder="Добавить пометку и нажать Enter"
                className="flex-1 px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm"
              />
              <button type="button" onClick={addTag} className="px-3 py-2 rounded-xl bg-bg hover:bg-border text-fg-muted hover:text-fg text-sm transition-colors">
                <Plus className="w-4 h-4" />
              </button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-2">
                {tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-pill bg-warning-bg text-warning-fg text-xs font-medium">
                    {t}
                    <button type="button" onClick={() => removeTag(t)} aria-label={`Убрать ${t}`} className="hover:opacity-70">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={isPending} className="px-5 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors disabled:opacity-50">
              Отмена
            </button>
            <button type="submit" disabled={isPending} className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50">
              {isPending ? 'Сохраняем…' : location ? 'Сохранить' : 'Создать'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
