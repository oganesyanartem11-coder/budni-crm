'use client'

import { useId, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Loader2, TriangleAlert } from 'lucide-react'
import { PhoneInput } from '@/components/ui/phone-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SalesField } from '@/components/sales/form-field'
import {
  CAPSULE_OUTLINE,
  CAPSULE_PRIMARY,
  CARD_CLASS,
  INPUT_CLASS,
  SELECT_TRIGGER_CLASS,
  TEXTAREA_CLASS,
} from '@/components/sales/styles'
import { parsePortions } from '@/components/sales/utils'
import { MANUAL_SOURCE_OPTIONS, type ManualSourceCode } from '@/lib/sales/labels'
import { isValidPhone } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import { createLead } from '../actions'

/**
 * Sprint 8.0 «Продажи»: форма ручной заявки /sales/new. Дубль по телефону
 * (активная заявка с тем же номером) — inline-предупреждение со ссылкой.
 */

type FieldErrors = Partial<Record<'name' | 'phone' | 'portions', string>>

export function NewLeadForm() {
  const router = useRouter()
  const ids = useId()
  const [isPending, startTransition] = useTransition()

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [company, setCompany] = useState('')
  const [email, setEmail] = useState('')
  const [sourceCode, setSourceCode] = useState<ManualSourceCode>('manual-phone')
  const [portions, setPortions] = useState('')
  const [address, setAddress] = useState('')
  const [comment, setComment] = useState('')

  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState<{ leadId: string | null } | null>(null)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)

    const nextErrors: FieldErrors = {}
    if (!name.trim()) nextErrors.name = 'Укажи, как зовут контакт'
    if (!isValidPhone(phone)) nextErrors.phone = 'Телефон в формате +7 (999) 999-99-99'
    const portionsHint = parsePortions(portions)
    if (portionsHint === undefined) nextErrors.portions = 'Целое число, например 40'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    startTransition(async () => {
      try {
        const result = await createLead({
          name: name.trim(),
          phone,
          company: company.trim() || null,
          email: email.trim() || null,
          portionsHint: portionsHint ?? null,
          address: address.trim() || null,
          comment: comment.trim() || null,
          sourceCode,
        })
        if (result.ok) {
          toast.success('Заявка создана')
          router.push(`/sales/${result.data.id}`)
          return
        }
        if (result.error === 'duplicate' || result.duplicateLeadId) {
          setDuplicate({ leadId: result.duplicateLeadId ?? null })
          return
        }
        setFormError(result.error)
        toast.error(result.error)
      } catch {
        const message = 'Не удалось создать заявку. Проверь связь и попробуй ещё раз'
        setFormError(message)
        toast.error(message)
      }
    })
  }

  return (
    <>
      <div className="mb-4">
        <Link
          href="/sales"
          className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-pill px-2 text-sm text-fg-muted transition-colors hover:text-fg-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [touch-action:manipulation]"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Все заявки
        </Link>
      </div>

      <form onSubmit={handleSubmit} noValidate className="max-w-2xl space-y-4">
        <div className={cn(CARD_CLASS, 'space-y-4')}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SalesField label="Контакт *" htmlFor={`${ids}-name`} error={errors.name}>
              <input
                id={`${ids}-name`}
                type="text"
                autoComplete="name"
                autoCapitalize="words"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Как зовут"
                aria-invalid={!!errors.name}
                className={cn(INPUT_CLASS, errors.name && 'border-danger')}
              />
            </SalesField>
            <SalesField label="Телефон *" htmlFor={`${ids}-phone`} error={errors.phone}>
              <PhoneInput
                id={`${ids}-phone`}
                value={phone}
                onChange={(v) => {
                  setPhone(v)
                  setDuplicate(null)
                }}
                hasError={!!errors.phone}
                aria-invalid={!!errors.phone}
                className="min-h-11 bg-surface text-base"
              />
            </SalesField>
          </div>

          {duplicate && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-warning-bg px-3 py-2 text-sm text-warning-fg"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                Уже есть активная заявка с этим номером
              </span>
              {duplicate.leadId && (
                <Link
                  href={`/sales/${duplicate.leadId}`}
                  className="inline-flex min-h-11 items-center rounded-pill px-2 font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Открыть
                </Link>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SalesField label="Компания" htmlFor={`${ids}-company`}>
              <input
                id={`${ids}-company`}
                type="text"
                autoComplete="organization"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className={INPUT_CLASS}
              />
            </SalesField>
            <SalesField label="Email" htmlFor={`${ids}-email`}>
              <input
                id={`${ids}-email`}
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={INPUT_CLASS}
              />
            </SalesField>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SalesField label="Источник" htmlFor={`${ids}-source`}>
              <Select value={sourceCode} onValueChange={(v) => setSourceCode(v as ManualSourceCode)}>
                <SelectTrigger id={`${ids}-source`} className={SELECT_TRIGGER_CLASS}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MANUAL_SOURCE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="min-h-11">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SalesField>
            <SalesField label="Порций в день" htmlFor={`${ids}-portions`} error={errors.portions}>
              <input
                id={`${ids}-portions`}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={portions}
                onChange={(e) => setPortions(e.target.value)}
                placeholder="Например, 40"
                aria-invalid={!!errors.portions}
                className={cn(INPUT_CLASS, 'tabular-nums', errors.portions && 'border-danger')}
              />
            </SalesField>
          </div>

          <SalesField label="Адрес" htmlFor={`${ids}-address`}>
            <input
              id={`${ids}-address`}
              type="text"
              autoComplete="street-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Куда возить"
              className={INPUT_CLASS}
            />
          </SalesField>

          <SalesField label="Комментарий" htmlFor={`${ids}-comment`}>
            <textarea
              id={`${ids}-comment`}
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="что сказал"
              className={TEXTAREA_CLASS}
            />
          </SalesField>
        </div>

        {formError && (
          <p role="alert" className="rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger-fg">
            {formError}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Link href="/sales" className={CAPSULE_OUTLINE}>
            Отмена
          </Link>
          <button type="submit" disabled={isPending} className={cn(CAPSULE_PRIMARY, 'w-full sm:w-auto')}>
            {isPending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            {isPending ? 'Создаём…' : 'Создать заявку'}
          </button>
        </div>
      </form>
    </>
  )
}
