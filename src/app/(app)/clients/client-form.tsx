'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { createClient, updateClient } from './actions'
import { PhoneInput } from '@/components/ui/phone-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isValidPhone } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import type { Client } from '@prisma/client'

interface Props {
  client?: Pick<Client, 'id' | 'name' | 'contactName' | 'contactPhone' | 'contactMessenger' | 'notes'>
  isNew?: boolean
}

export function ClientForm({ client, isNew = false }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [name, setName] = useState(client?.name ?? '')
  const [contactName, setContactName] = useState(client?.contactName ?? '')
  const [contactPhone, setContactPhone] = useState(client?.contactPhone ?? '')
  const [contactMessenger, setContactMessenger] = useState(client?.contactMessenger ?? '')
  const [notes, setNotes] = useState(client?.notes ?? '')

  // Поля первой точки (только при создании)
  const [locName, setLocName] = useState('')
  const [locAddress, setLocAddress] = useState('')
  const [locFrom, setLocFrom] = useState('')
  const [locTo, setLocTo] = useState('')
  const [locPackaging, setLocPackaging] = useState<'INDIVIDUAL' | 'BULK'>('INDIVIDUAL')

  const [error, setError] = useState<string | null>(null)
  const [phoneError, setPhoneError] = useState<string | null>(null)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!name.trim()) {
      setError('Название клиента обязательно')
      return
    }

    // Валидация телефона: либо пусто, либо полный формат
    if (contactPhone.trim() && !isValidPhone(contactPhone)) {
      setPhoneError('Телефон должен быть в формате +7 (999) 999-99-99')
      return
    }
    setPhoneError(null)

    startTransition(async () => {
      const baseData = {
        name: name.trim(),
        contactName: contactName.trim() || null,
        contactPhone: contactPhone.trim() || null,
        contactMessenger: contactMessenger.trim() || null,
        notes: notes.trim() || null,
      }

      if (isNew) {
        const firstLocation = locName.trim() && locAddress.trim()
          ? {
              name: locName.trim(),
              address: locAddress.trim(),
              deliveryWindowFrom: locFrom || null,
              deliveryWindowTo: locTo || null,
              packaging: locPackaging,
              tags: [],
            }
          : undefined

        const result = await createClient({ ...baseData, firstLocation })
        if (result.ok) {
          toast.success('Клиент создан')
          router.push(`/clients/${result.data.id}`)
          router.refresh()
        } else {
          toast.error(result.error)
        }
      } else if (client) {
        const result = await updateClient(client.id, baseData)
        if (result.ok) {
          toast.success('Клиент обновлён')
          router.push(`/clients/${client.id}`)
          router.refresh()
        } else {
          toast.error(result.error)
        }
      }
    })
  }

  return (
    <>
      <div className="mb-6">
        <Link
          href={client ? `/clients/${client.id}` : '/clients'}
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          {client ? 'К карточке клиента' : 'Все клиенты'}
        </Link>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="rounded-2xl bg-surface border border-border p-6 space-y-5" style={{ boxShadow: 'var(--shadow-card)' }}>
          <h2 className="text-lg font-semibold">Основное</h2>

          <Field label="Название клиента *" error={error}>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors"
            />
          </Field>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Контактное лицо">
              <input
                type="text"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors"
              />
            </Field>
            <Field label="Телефон" error={phoneError}>
              <PhoneInput
                value={contactPhone}
                onChange={setContactPhone}
                hasError={!!phoneError}
              />
            </Field>
          </div>

          <Field label="Мессенджер" hint="Username или ссылка (Telegram, MAX)">
            <input
              type="text"
              value={contactMessenger}
              onChange={(e) => setContactMessenger(e.target.value)}
              placeholder="@username"
              className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors"
            />
          </Field>

          <Field label="Заметки">
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Особенности клиента, договорённости"
              className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors resize-none"
            />
          </Field>
        </div>

        {isNew && (
          <div className="rounded-2xl bg-surface border border-border p-6 space-y-5" style={{ boxShadow: 'var(--shadow-card)' }}>
            <div>
              <h2 className="text-lg font-semibold">Первая точка</h2>
              <p className="text-xs text-fg-muted mt-1">Можно создать сразу или добавить потом из карточки клиента</p>
            </div>

            <Field label="Название точки">
              <input
                type="text"
                value={locName}
                onChange={(e) => setLocName(e.target.value)}
                placeholder="Например, Главный офис"
                className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors"
              />
            </Field>

            <Field label="Адрес">
              <input
                type="text"
                value={locAddress}
                onChange={(e) => setLocAddress(e.target.value)}
                placeholder="Улица, дом, офис"
                className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors"
              />
            </Field>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Окно с" hint="HH:MM">
                <input
                  type="time"
                  value={locFrom}
                  onChange={(e) => setLocFrom(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors"
                />
              </Field>
              <Field label="Окно до" hint="HH:MM">
                <input
                  type="time"
                  value={locTo}
                  onChange={(e) => setLocTo(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors"
                />
              </Field>
              <Field label="Упаковка">
                <Select value={locPackaging} onValueChange={(v) => setLocPackaging(v as 'INDIVIDUAL' | 'BULK')}>
                  <SelectTrigger className="w-full !h-auto px-3 py-2.5 rounded-xl bg-bg border-border focus-visible:border-accent focus-visible:ring-0 transition-colors data-placeholder:text-fg-muted">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INDIVIDUAL">Порционно</SelectItem>
                    <SelectItem value="BULK">Коробками</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Link
            href={client ? `/clients/${client.id}` : '/clients'}
            className="px-5 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors"
          >
            Отмена
          </Link>
          <button
            type="submit"
            disabled={isPending}
            className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isPending ? 'Сохраняем…' : isNew ? 'Создать клиента' : 'Сохранить'}
          </button>
        </div>
      </form>
    </>
  )
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && !error && <p className="text-xs text-fg-subtle">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}
