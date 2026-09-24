'use client'

import { useId, useState } from 'react'
import { Loader2, Pencil } from 'lucide-react'
import { PhoneInput } from '@/components/ui/phone-input'
import { SalesField } from '@/components/sales/form-field'
import {
  CAPSULE_OUTLINE,
  CAPSULE_PRIMARY,
  CARD_CLASS,
  ICON_BUTTON,
  INPUT_CLASS,
  SECTION_TITLE_CLASS,
  TEXTAREA_CLASS,
} from '@/components/sales/styles'
import { useSalesMutation } from '@/components/sales/use-sales-mutation'
import { parsePortions } from '@/components/sales/utils'
import { PhoneLink } from '@/components/ui/phone-link'
import type { LeadDetail, UpdateLeadFieldsInput } from '@/lib/sales/types'
import { formatPhoneMask, isValidPhone } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import { updateLeadFields } from '../actions'

interface FormState {
  name: string
  phone: string
  company: string
  email: string
  portions: string
  address: string
  comment: string
}

function toFormState(lead: LeadDetail): FormState {
  return {
    name: lead.name ?? '',
    phone: formatPhoneMask(lead.phone),
    company: lead.company ?? '',
    email: lead.email ?? '',
    portions: lead.portionsHint !== null ? String(lead.portionsHint) : '',
    address: lead.address ?? '',
    comment: lead.comment ?? '',
  }
}

type FieldErrors = Partial<Record<'phone' | 'portions', string>>

/** Поля заявки: просмотр + inline-редактирование (карандаш). Шлём только изменённое. */
export function LeadFieldsBlock({ lead }: { lead: LeadDetail }) {
  const [editing, setEditing] = useState(false)

  return (
    <section aria-labelledby="lead-fields-title" className={CARD_CLASS}>
      <div className="flex items-center justify-between gap-3">
        <h2 id="lead-fields-title" className={SECTION_TITLE_CLASS}>
          Данные заявки
        </h2>
        {!editing && (
          <button
            type="button"
            aria-label="Редактировать данные заявки"
            title="Редактировать"
            onClick={() => setEditing(true)}
            className={ICON_BUTTON}
          >
            <Pencil className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {editing ? (
        <LeadFieldsForm lead={lead} onDone={() => setEditing(false)} />
      ) : (
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
          <FieldView label="Контакт" value={lead.name} />
          <FieldView label="Телефон">
            <PhoneLink phone={lead.phone} className="font-medium text-fg tabular-nums" />
          </FieldView>
          <FieldView label="Компания" value={lead.company} />
          <FieldView label="Email" value={lead.email} />
          <FieldView
            label="Порций в день"
            value={lead.portionsHint !== null ? String(lead.portionsHint) : null}
          />
          <FieldView label="Адрес" value={lead.address} />
          <FieldView label="Комментарий" value={lead.comment} wide />
        </dl>
      )}
    </section>
  )
}

function FieldView({
  label,
  value,
  wide,
  children,
}: {
  label: string
  value?: string | null
  wide?: boolean
  children?: React.ReactNode
}) {
  const content = children ?? (value?.trim() ? value : null)
  return (
    <div className={cn('min-w-0', wide && 'sm:col-span-2')}>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className={cn('mt-0.5 whitespace-pre-line break-words', content ? 'text-fg' : 'text-fg-subtle')}>
        {content ?? '—'}
      </dd>
    </div>
  )
}

function LeadFieldsForm({ lead, onDone }: { lead: LeadDetail; onDone: () => void }) {
  const ids = useId()
  const { run, isPending } = useSalesMutation()
  const [initial] = useState(() => toFormState(lead))
  const [form, setForm] = useState<FormState>(initial)
  const [errors, setErrors] = useState<FieldErrors>({})

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const patch: UpdateLeadFieldsInput = { leadId: lead.id }
    const nextErrors: FieldErrors = {}

    const textFields = ['name', 'company', 'email', 'address', 'comment'] as const
    for (const key of textFields) {
      const next = form[key].trim()
      if (next !== initial[key].trim()) patch[key] = next || null
    }

    if (form.phone !== initial.phone) {
      if (!isValidPhone(form.phone)) nextErrors.phone = 'Телефон в формате +7 (999) 999-99-99'
      else patch.phone = form.phone
    }

    if (form.portions.trim() !== initial.portions) {
      const portions = parsePortions(form.portions)
      if (portions === undefined) nextErrors.portions = 'Целое число, например 40'
      else patch.portionsHint = portions
    }

    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    if (Object.keys(patch).length === 1) {
      onDone()
      return
    }
    run(() => updateLeadFields(patch), { success: 'Данные заявки сохранены', onSuccess: onDone })
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="mt-3 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SalesField label="Контакт" htmlFor={`${ids}-name`}>
          <input
            id={`${ids}-name`}
            type="text"
            autoComplete="name"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            className={INPUT_CLASS}
          />
        </SalesField>
        <SalesField label="Телефон" htmlFor={`${ids}-phone`} error={errors.phone}>
          <PhoneInput
            id={`${ids}-phone`}
            value={form.phone}
            onChange={(v) => set('phone', v)}
            hasError={!!errors.phone}
            aria-invalid={!!errors.phone}
            className="min-h-11 bg-surface text-base"
          />
        </SalesField>
        <SalesField label="Компания" htmlFor={`${ids}-company`}>
          <input
            id={`${ids}-company`}
            type="text"
            autoComplete="organization"
            value={form.company}
            onChange={(e) => set('company', e.target.value)}
            className={INPUT_CLASS}
          />
        </SalesField>
        <SalesField label="Email" htmlFor={`${ids}-email`}>
          <input
            id={`${ids}-email`}
            type="email"
            inputMode="email"
            autoCapitalize="none"
            autoComplete="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            className={INPUT_CLASS}
          />
        </SalesField>
        <SalesField label="Порций в день" htmlFor={`${ids}-portions`} error={errors.portions}>
          <input
            id={`${ids}-portions`}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={form.portions}
            onChange={(e) => set('portions', e.target.value)}
            aria-invalid={!!errors.portions}
            className={cn(INPUT_CLASS, 'tabular-nums', errors.portions && 'border-danger')}
          />
        </SalesField>
        <SalesField label="Адрес" htmlFor={`${ids}-address`}>
          <input
            id={`${ids}-address`}
            type="text"
            autoComplete="street-address"
            value={form.address}
            onChange={(e) => set('address', e.target.value)}
            className={INPUT_CLASS}
          />
        </SalesField>
      </div>
      <SalesField label="Комментарий" htmlFor={`${ids}-comment`}>
        <textarea
          id={`${ids}-comment`}
          rows={3}
          value={form.comment}
          onChange={(e) => set('comment', e.target.value)}
          className={TEXTAREA_CLASS}
        />
      </SalesField>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={onDone} disabled={isPending} className={CAPSULE_OUTLINE}>
          Отмена
        </button>
        <button type="submit" disabled={isPending} className={CAPSULE_PRIMARY}>
          {isPending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {isPending ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </form>
  )
}
