'use client'

import { useEffect, useState } from 'react'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import {
  legalEntitySchema,
  type LegalEntityFormData,
} from '@/lib/validation/legal-entity'
import { createLegalEntity, updateLegalEntity } from './actions'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { PhoneInput } from '@/components/ui/phone-input'
import { cn } from '@/lib/utils/cn'
import type { LegalEntityType, VatMode } from '@prisma/client'

interface SerializedEntity {
  id: string
  shortName: string
  fullName: string
  entityType: LegalEntityType
  inn: string
  kpp: string | null
  ogrn: string
  legalAddress: string
  phone: string | null
  email: string | null
  bankName: string
  bankBic: string
  bankAccount: string
  bankCorrAccount: string
  directorName: string
  directorPosition: string
  vatMode: VatMode
  vatRate: number | null
}

interface Props {
  mode: 'create' | 'edit'
  initialData?: SerializedEntity
}

const IE_DIRECTOR_POSITION_DEFAULT = 'Индивидуальный предприниматель'
const LLC_DIRECTOR_POSITION_DEFAULT = 'Директор'
const DEFAULT_VAT_RATE = 10

function getDefaults(initial?: SerializedEntity): LegalEntityFormData {
  if (initial) {
    return {
      shortName: initial.shortName,
      fullName: initial.fullName,
      entityType: initial.entityType,
      inn: initial.inn,
      kpp: initial.kpp ?? '',
      ogrn: initial.ogrn,
      legalAddress: initial.legalAddress,
      phone: initial.phone ?? '',
      email: initial.email ?? '',
      bankName: initial.bankName,
      bankBic: initial.bankBic,
      bankAccount: initial.bankAccount,
      bankCorrAccount: initial.bankCorrAccount,
      directorName: initial.directorName,
      directorPosition: initial.directorPosition,
      vatMode: initial.vatMode,
      vatRate: initial.vatRate ?? undefined,
    }
  }
  return {
    shortName: '',
    fullName: '',
    entityType: 'INDIVIDUAL_ENTREPRENEUR',
    inn: '',
    kpp: '',
    ogrn: '',
    legalAddress: '',
    phone: '',
    email: '',
    bankName: '',
    bankBic: '',
    bankAccount: '',
    bankCorrAccount: '',
    directorName: '',
    directorPosition: IE_DIRECTOR_POSITION_DEFAULT,
    vatMode: 'NONE',
    vatRate: undefined,
  }
}

export function LegalEntityForm({ mode, initialData }: Props) {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors },
  } = useForm<LegalEntityFormData>({
    // zod 4 различает input/output типы; @hookform/resolvers даёт
    // несовместимый по структуре Resolver. Явно приводим к нашему типу формы.
    resolver: zodResolver(legalEntitySchema) as unknown as Resolver<LegalEntityFormData>,
    defaultValues: getDefaults(initialData),
    mode: 'onSubmit',
  })

  const entityType = watch('entityType')
  const vatMode = watch('vatMode')
  const phone = watch('phone') ?? ''
  const directorPosition = watch('directorPosition')
  const vatRate = watch('vatRate')

  function handleEntityTypeChange(value: LegalEntityType) {
    setValue('entityType', value, { shouldValidate: false })

    if (value === 'INDIVIDUAL_ENTREPRENEUR') {
      setValue('kpp', '')
      if (
        directorPosition === LLC_DIRECTOR_POSITION_DEFAULT ||
        !directorPosition?.trim()
      ) {
        setValue('directorPosition', IE_DIRECTOR_POSITION_DEFAULT)
      }
    } else {
      if (
        directorPosition === IE_DIRECTOR_POSITION_DEFAULT ||
        !directorPosition?.trim()
      ) {
        setValue('directorPosition', LLC_DIRECTOR_POSITION_DEFAULT)
      }
    }
  }

  // Если режим НДС включается, а ставки нет — выставим 10 (для пилота это
  // единственная ненулевая ставка). Если выключается — сбрасываем в undefined,
  // чтобы superRefine не ругался про «лишнюю ставку».
  useEffect(() => {
    if (vatMode === 'VAT_10_INCLUSIVE' && (vatRate === undefined || vatRate === null)) {
      setValue('vatRate', DEFAULT_VAT_RATE)
    }
    if (vatMode === 'NONE' && vatRate !== undefined) {
      setValue('vatRate', undefined)
    }
  }, [vatMode, vatRate, setValue])

  async function onSubmit(data: LegalEntityFormData) {
    setIsSubmitting(true)
    try {
      const result =
        mode === 'create'
          ? await createLegalEntity(data)
          : await updateLegalEntity(initialData!.id, data)

      if (result.ok) {
        toast.success(mode === 'create' ? 'Юрлицо создано' : 'Сохранено')
        router.push('/settings/legal-entities')
        router.refresh()
      } else {
        if (result.fieldErrors) {
          for (const [field, message] of Object.entries(result.fieldErrors)) {
            setError(field as keyof LegalEntityFormData, {
              type: 'server',
              message,
            })
          }
        }
        toast.error(result.error)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  const innHint =
    entityType === 'INDIVIDUAL_ENTREPRENEUR'
      ? '12 цифр (ИНН ИП)'
      : '10 цифр (ИНН организации)'
  const ogrnHint =
    entityType === 'INDIVIDUAL_ENTREPRENEUR'
      ? '15 цифр (ОГРНИП)'
      : '13 цифр (ОГРН)'

  return (
    <>
      <div className="mb-6">
        <Link
          href="/settings/legal-entities"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К списку юрлиц
        </Link>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 pb-24">
        {/* Секция 1: Основное */}
        <Section title="Основные данные">
          <Field label="Тип юрлица *">
            <Select
              value={entityType}
              onValueChange={(v) => handleEntityTypeChange(v as LegalEntityType)}
            >
              <SelectTrigger className="w-full !h-auto px-3 py-2.5 rounded-xl bg-bg border-border focus-visible:border-accent focus-visible:ring-0 transition-colors data-placeholder:text-fg-muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="INDIVIDUAL_ENTREPRENEUR">Индивидуальный предприниматель</SelectItem>
                <SelectItem value="LLC">Общество с ограниченной ответственностью</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="Краткое наименование *" error={errors.shortName?.message}>
            <TextInput {...register('shortName')} placeholder="ИП Акопов" hasError={!!errors.shortName} />
          </Field>

          <Field
            label="Полное юридическое название *"
            hint="Как указано в УПД"
            error={errors.fullName?.message}
          >
            <TextInput
              {...register('fullName')}
              placeholder="Индивидуальный предприниматель Акопов Олег Армаисович"
              hasError={!!errors.fullName}
            />
          </Field>
        </Section>

        {/* Секция 2: Регистрация */}
        <Section title="Регистрация">
          <Field label="ИНН *" hint={innHint} error={errors.inn?.message}>
            <TextInput
              {...register('inn')}
              inputMode="numeric"
              hasError={!!errors.inn}
              placeholder={entityType === 'INDIVIDUAL_ENTREPRENEUR' ? '500305443459' : '7751330460'}
            />
          </Field>

          {entityType === 'LLC' && (
            <Field label="КПП *" hint="9 цифр" error={errors.kpp?.message}>
              <TextInput
                {...register('kpp')}
                inputMode="numeric"
                hasError={!!errors.kpp}
                placeholder="775101001"
              />
            </Field>
          )}

          <Field label="ОГРН / ОГРНИП *" hint={ogrnHint} error={errors.ogrn?.message}>
            <TextInput
              {...register('ogrn')}
              inputMode="numeric"
              hasError={!!errors.ogrn}
              placeholder={entityType === 'INDIVIDUAL_ENTREPRENEUR' ? '325774600667211' : '1247700624753'}
            />
          </Field>

          <Field
            label="Юридический адрес *"
            error={errors.legalAddress?.message}
          >
            <textarea
              {...register('legalAddress')}
              rows={2}
              placeholder="123456, г. Москва, ул. Ленина, д. 10, оф. 5"
              className={cn(
                'w-full px-3 py-2.5 rounded-xl bg-bg border focus:outline-none focus:border-accent transition-colors resize-none text-sm',
                errors.legalAddress ? 'border-danger' : 'border-border'
              )}
            />
          </Field>
        </Section>

        {/* Секция 3: Контакты */}
        <Section title="Контакты">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Телефон" error={errors.phone?.message}>
              <PhoneInput
                value={phone}
                onChange={(v) => setValue('phone', v)}
                hasError={!!errors.phone}
              />
            </Field>
            <Field label="Email" error={errors.email?.message}>
              <TextInput
                {...register('email')}
                type="email"
                placeholder="info@example.com"
                hasError={!!errors.email}
              />
            </Field>
          </div>
        </Section>

        {/* Секция 4: Банк */}
        <Section title="Банковские реквизиты">
          <Field label="Наименование банка *" error={errors.bankName?.message}>
            <TextInput
              {...register('bankName')}
              placeholder='АО "АЛЬФА-БАНК"'
              hasError={!!errors.bankName}
            />
          </Field>

          <Field
            label="БИК *"
            hint="9 цифр, начинается с 04"
            error={errors.bankBic?.message}
          >
            <TextInput
              {...register('bankBic')}
              inputMode="numeric"
              hasError={!!errors.bankBic}
              placeholder="044525593"
            />
          </Field>

          <Field
            label="Расчётный счёт *"
            hint="20 цифр"
            error={errors.bankAccount?.message}
          >
            <TextInput
              {...register('bankAccount')}
              inputMode="numeric"
              hasError={!!errors.bankAccount}
              placeholder="40802810000000000000"
            />
          </Field>

          <Field
            label="Корреспондентский счёт *"
            hint="20 цифр"
            error={errors.bankCorrAccount?.message}
          >
            <TextInput
              {...register('bankCorrAccount')}
              inputMode="numeric"
              hasError={!!errors.bankCorrAccount}
              placeholder="30101810200000000593"
            />
          </Field>
        </Section>

        {/* Секция 5: Подписант */}
        <Section title="Подписант">
          <Field label="ФИО подписанта *" error={errors.directorName?.message}>
            <TextInput
              {...register('directorName')}
              placeholder="Акопов Олег Армаисович"
              hasError={!!errors.directorName}
            />
          </Field>

          <Field label="Должность *" error={errors.directorPosition?.message}>
            <TextInput
              {...register('directorPosition')}
              hasError={!!errors.directorPosition}
            />
          </Field>
        </Section>

        {/* Секция 6: НДС */}
        <Section title="НДС">
          <RadioGroup
            value={vatMode}
            onValueChange={(v) => setValue('vatMode', v as VatMode)}
            className="space-y-2"
          >
            <label className="flex items-center gap-2.5 cursor-pointer">
              <RadioGroupItem value="NONE" />
              <span className="text-sm">Без НДС</span>
            </label>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <RadioGroupItem value="VAT_10_INCLUSIVE" />
              <span className="text-sm">НДС 10% (включён в цену)</span>
            </label>
          </RadioGroup>

          {vatMode === 'VAT_10_INCLUSIVE' && (
            <Field
              label="Ставка НДС, %"
              hint="По умолчанию 10"
              error={errors.vatRate?.message}
            >
              <TextInput
                type="number"
                step="0.5"
                min="0"
                max="100"
                {...register('vatRate', { valueAsNumber: true })}
                hasError={!!errors.vatRate}
              />
            </Field>
          )}
        </Section>

        {/* Sticky-row снизу */}
        <div className="fixed bottom-0 left-0 right-0 lg:left-[220px] bg-surface/95 backdrop-blur border-t border-border px-6 py-3 flex justify-end gap-2 z-30">
          <Link
            href="/settings/legal-entities"
            className="px-5 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors"
          >
            Отмена
          </Link>
          <button
            type="submit"
            disabled={isSubmitting}
            className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isSubmitting ? 'Сохраняем…' : mode === 'create' ? 'Создать' : 'Сохранить'}
          </button>
        </div>
      </form>
    </>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      className="rounded-2xl bg-surface border border-border p-6 space-y-5"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </div>
  )
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string | null
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && !error && <p className="text-xs text-fg-subtle">{hint}</p>}
      {error && <p className="text-xs text-danger-fg">{error}</p>}
    </div>
  )
}

// React 19: ref передаётся как обычный пропс. Прокидываем в <input>, иначе
// react-hook-form не сможет программно сфокусировать поле при ошибке.
function TextInput({
  hasError,
  className,
  ref,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  hasError?: boolean
  ref?: React.Ref<HTMLInputElement>
}) {
  return (
    <input
      ref={ref}
      type={props.type ?? 'text'}
      {...props}
      className={cn(
        'w-full px-3 py-2.5 rounded-xl bg-bg border focus:outline-none focus:border-accent transition-colors text-sm',
        hasError ? 'border-danger' : 'border-border',
        className
      )}
    />
  )
}
