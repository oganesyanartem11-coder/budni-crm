'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient, updateClient } from './actions'
import { PhoneInput } from '@/components/ui/phone-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isValidPhone } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import type { Client } from '@prisma/client'

type ClientPick = Pick<
  Client,
  | 'id'
  | 'name'
  | 'contactName'
  | 'contactPhone'
  | 'contactMessenger'
  | 'notes'
  | 'legalName'
  | 'inn'
  | 'kpp'
  | 'ogrn'
  | 'legalAddress'
  | 'bankName'
  | 'bankBic'
  | 'bankAccount'
  | 'bankCorrAccount'
  | 'contractNumber'
  | 'defaultOurLegalEntityId'
>

interface LegalEntityOption {
  id: string
  shortName: string
  entityType: 'INDIVIDUAL_ENTREPRENEUR' | 'LLC'
}

// serialize() в проекте сохраняет Date как Date — поэтому contractDate
// приходит либо как Date (из server component), либо как string (если уже
// сериализован JSON-ом где-то), либо null. Поддерживаем оба варианта.
type SerializedClient = ClientPick & { contractDate: Date | string | null }

interface Props {
  client?: SerializedClient
  isNew?: boolean
  legalEntities: LegalEntityOption[]
}

const NO_LEGAL_ENTITY = '__none__'

// Общие классы инпутов в DNA «Bento Editorial»
const INPUT_CLASS =
  'w-full px-3 py-2.5 min-h-[44px] rounded-xl bg-surface border border-border text-fg placeholder:text-fg-subtle focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors [touch-action:manipulation]'
const TEXTAREA_CLASS = INPUT_CLASS + ' resize-none'
const SELECT_TRIGGER_CLASS =
  'w-full !h-auto min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border-border text-fg focus-visible:border-brand-green focus-visible:ring-1 focus-visible:ring-brand-green/30 focus-visible:outline-none transition-colors data-placeholder:text-fg-subtle [touch-action:manipulation]'
const CARD_CLASS = 'rounded-2xl bg-surface border border-border p-6 space-y-5 shadow-card'
const SECTION_TITLE_CLASS = 'font-display font-bold text-lg text-fg-strong'

function dateToInputValue(d: Date | string | null | undefined): string {
  if (!d) return ''
  if (d instanceof Date) return d.toISOString().slice(0, 10)
  return d.slice(0, 10)
}

export function ClientForm({ client, isNew = false, legalEntities }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [name, setName] = useState(client?.name ?? '')
  const [contactName, setContactName] = useState(client?.contactName ?? '')
  const [contactPhone, setContactPhone] = useState(client?.contactPhone ?? '')
  const [contactMessenger, setContactMessenger] = useState(client?.contactMessenger ?? '')
  const [notes, setNotes] = useState(client?.notes ?? '')

  // Юридические реквизиты
  const [legalName, setLegalName] = useState(client?.legalName ?? '')
  const [inn, setInn] = useState(client?.inn ?? '')
  const [kpp, setKpp] = useState(client?.kpp ?? '')
  const [ogrn, setOgrn] = useState(client?.ogrn ?? '')
  const [legalAddress, setLegalAddress] = useState(client?.legalAddress ?? '')
  const [defaultOurLegalEntityId, setDefaultOurLegalEntityId] = useState(
    client?.defaultOurLegalEntityId ?? ''
  )

  // Банк
  const [bankName, setBankName] = useState(client?.bankName ?? '')
  const [bankBic, setBankBic] = useState(client?.bankBic ?? '')
  const [bankAccount, setBankAccount] = useState(client?.bankAccount ?? '')
  const [bankCorrAccount, setBankCorrAccount] = useState(client?.bankCorrAccount ?? '')

  // Договор
  const [contractNumber, setContractNumber] = useState(client?.contractNumber ?? '')
  const [contractDate, setContractDate] = useState(dateToInputValue(client?.contractDate ?? null))

  // Поля первой точки (только при создании)
  const [locName, setLocName] = useState('')
  const [locAddress, setLocAddress] = useState('')
  const [locFrom, setLocFrom] = useState('')
  const [locTo, setLocTo] = useState('')
  const [locPackaging, setLocPackaging] = useState<'INDIVIDUAL' | 'BULK'>('INDIVIDUAL')

  const [error, setError] = useState<string | null>(null)
  const [phoneError, setPhoneError] = useState<string | null>(null)

  // Динамика: «клиент-юрлицо?» определяется по непустому ИНН
  const innFilled = inn.trim() !== ''
  const innLen = inn.replace(/\D/g, '').length
  const isLLCByInn = innLen === 10
  const isIEByInn = innLen === 12
  const ogrnHint = useMemo(() => {
    if (isLLCByInn) return '13 цифр (ОГРН организации)'
    if (isIEByInn) return '15 цифр (ОГРНИП)'
    return 'Контрольная сумма и длина проверяются после ввода ИНН'
  }, [isLLCByInn, isIEByInn])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!name.trim()) {
      setError('Название клиента обязательно')
      return
    }

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

        legalName: legalName.trim(),
        inn: inn.trim(),
        kpp: kpp.trim(),
        ogrn: ogrn.trim(),
        legalAddress: legalAddress.trim(),

        bankName: bankName.trim(),
        bankBic: bankBic.trim(),
        bankAccount: bankAccount.trim(),
        bankCorrAccount: bankCorrAccount.trim(),

        contractNumber: contractNumber.trim(),
        contractDate: contractDate,

        defaultOurLegalEntityId: defaultOurLegalEntityId || '',
      }

      if (isNew) {
        const firstLocation =
          locName.trim() && locAddress.trim()
            ? {
                name: locName.trim(),
                address: locAddress.trim(),
                deliveryWindowFrom: locFrom || null,
                deliveryWindowTo: locTo || null,
                packaging: locPackaging,
                tags: [] as string[],
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
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-strong transition-colors rounded-lg [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30"
        >
          <ArrowLeft className="w-4 h-4" />
          {client ? 'К карточке клиента' : 'Все клиенты'}
        </Link>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className={CARD_CLASS}>
          <h2 className={SECTION_TITLE_CLASS}>Основное</h2>

          <Field label="Название клиента *" error={error}>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={INPUT_CLASS}
            />
          </Field>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Контактное лицо">
              <input
                type="text"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                className={INPUT_CLASS}
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
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="Заметки">
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Особенности клиента, договорённости"
              className={TEXTAREA_CLASS}
            />
          </Field>
        </div>

        {/* === Юридические данные === */}
        <div
          className={cn(
            'rounded-2xl bg-surface border p-6 space-y-5 shadow-card transition-colors',
            innFilled ? 'border-warning' : 'border-border'
          )}
        >
          <div>
            <h2 className={SECTION_TITLE_CLASS}>Юридические данные</h2>
            <p className="text-xs text-fg-subtle mt-1">
              Заполните, если клиент — юрлицо или ИП. ИНН — главное поле: при его
              заполнении остальные станут обязательными.
            </p>
          </div>

          <Field label="ИНН" hint="10 цифр для организации, 12 цифр для ИП. Оставьте пустым, если клиент не юрлицо.">
            <input
              type="text"
              inputMode="numeric"
              value={inn}
              onChange={(e) => setInn(e.target.value)}
              placeholder="7751330460 / 500305443459"
              className={cn(INPUT_CLASS, innFilled && 'border-warning focus:border-warning focus:ring-warning/30')}
            />
          </Field>

          <Field label={`Полное юридическое название${innFilled ? ' *' : ''}`} hint="Как в УПД">
            <input
              type="text"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder='Общество с ограниченной ответственностью "Ромашка"'
              className={INPUT_CLASS}
            />
          </Field>

          {(isLLCByInn || (!isIEByInn && innFilled)) && (
            <Field label={`КПП${isLLCByInn ? ' *' : ''}`} hint="9 цифр">
              <input
                type="text"
                inputMode="numeric"
                value={kpp}
                onChange={(e) => setKpp(e.target.value)}
                placeholder="775101001"
                className={INPUT_CLASS}
              />
            </Field>
          )}

          <Field label={`ОГРН / ОГРНИП${innFilled ? ' *' : ''}`} hint={ogrnHint}>
            <input
              type="text"
              inputMode="numeric"
              value={ogrn}
              onChange={(e) => setOgrn(e.target.value)}
              placeholder={isIEByInn ? '325774600667211' : '1247700624753'}
              className={INPUT_CLASS}
            />
          </Field>

          <Field label={`Юридический адрес${innFilled ? ' *' : ''}`}>
            <textarea
              rows={2}
              value={legalAddress}
              onChange={(e) => setLegalAddress(e.target.value)}
              placeholder="123456, г. Москва, ул. Ленина, д. 10, оф. 5"
              className={TEXTAREA_CLASS}
            />
          </Field>

          <Field
            label={`Наше юрлицо для отгрузки${innFilled ? ' *' : ''}`}
            hint="Кем мы будем выписывать этому клиенту УПД"
          >
            <Select
              value={defaultOurLegalEntityId === '' ? NO_LEGAL_ENTITY : defaultOurLegalEntityId}
              onValueChange={(v) =>
                setDefaultOurLegalEntityId(v === NO_LEGAL_ENTITY ? '' : v)
              }
              disabled={legalEntities.length === 0}
            >
              <SelectTrigger className={SELECT_TRIGGER_CLASS}>
                <SelectValue placeholder={legalEntities.length === 0 ? 'Нет активных юрлиц — добавьте их в Настройках' : '— Выберите наше юрлицо —'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_LEGAL_ENTITY}>— не выбрано —</SelectItem>
                {legalEntities.map((le) => (
                  <SelectItem key={le.id} value={le.id}>
                    {le.shortName} ({le.entityType === 'LLC' ? 'ООО' : 'ИП'})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {/* === Банковские реквизиты клиента === */}
        <div className={CARD_CLASS}>
          <div>
            <h2 className={SECTION_TITLE_CLASS}>Банковские реквизиты клиента</h2>
            <p className="text-xs text-fg-subtle mt-1">
              Опционально. Если оставить пустым — в УПД будет прочерк. Заполнять надо все четыре поля сразу.
            </p>
          </div>

          <Field label="Наименование банка">
            <input
              type="text"
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              placeholder='АО "АЛЬФА-БАНК"'
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="БИК" hint="9 цифр, начинается с 04">
            <input
              type="text"
              inputMode="numeric"
              value={bankBic}
              onChange={(e) => setBankBic(e.target.value)}
              placeholder="044525593"
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="Расчётный счёт" hint="20 цифр">
            <input
              type="text"
              inputMode="numeric"
              value={bankAccount}
              onChange={(e) => setBankAccount(e.target.value)}
              placeholder="40702810801300049855"
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="Корреспондентский счёт" hint="20 цифр">
            <input
              type="text"
              inputMode="numeric"
              value={bankCorrAccount}
              onChange={(e) => setBankCorrAccount(e.target.value)}
              placeholder="30101810200000000593"
              className={INPUT_CLASS}
            />
          </Field>
        </div>

        {/* === Договор === */}
        <div className={CARD_CLASS}>
          <div>
            <h2 className={SECTION_TITLE_CLASS}>Договор</h2>
            <p className="text-xs text-fg-subtle mt-1">
              Опционально. Если заполнить — в УПД появится строка «По договору № X от DD.MM.YYYY».
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Номер договора">
              <input
                type="text"
                value={contractNumber}
                onChange={(e) => setContractNumber(e.target.value)}
                placeholder="2024-001"
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Дата договора">
              <input
                type="date"
                value={contractDate}
                onChange={(e) => setContractDate(e.target.value)}
                className={INPUT_CLASS}
              />
            </Field>
          </div>
        </div>

        {isNew && (
          <div className={CARD_CLASS}>
            <div>
              <h2 className={SECTION_TITLE_CLASS}>Первая точка</h2>
              <p className="text-xs text-fg-subtle mt-1">Можно создать сразу или добавить потом из карточки клиента</p>
            </div>

            <Field label="Название точки">
              <input
                type="text"
                value={locName}
                onChange={(e) => setLocName(e.target.value)}
                placeholder="Например, Главный офис"
                className={INPUT_CLASS}
              />
            </Field>

            <Field label="Адрес">
              <input
                type="text"
                value={locAddress}
                onChange={(e) => setLocAddress(e.target.value)}
                placeholder="Улица, дом, офис"
                className={INPUT_CLASS}
              />
            </Field>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Окно с" hint="HH:MM">
                <input
                  type="time"
                  value={locFrom}
                  onChange={(e) => setLocFrom(e.target.value)}
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Окно до" hint="HH:MM">
                <input
                  type="time"
                  value={locTo}
                  onChange={(e) => setLocTo(e.target.value)}
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Упаковка">
                <Select value={locPackaging} onValueChange={(v) => setLocPackaging(v as 'INDIVIDUAL' | 'BULK')}>
                  <SelectTrigger className={SELECT_TRIGGER_CLASS}>
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
            className="inline-flex items-center justify-center min-h-[44px] px-5 py-2.5 rounded-xl border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-surface-2 hover:text-fg-strong transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30"
          >
            Отмена
          </Link>
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex items-center justify-center min-h-[44px] px-5 py-2.5 rounded-xl bg-brand-orange text-white font-medium text-sm hover:bg-brand-orange-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
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
    <div>
      <label className="block text-fg-muted uppercase text-xs font-bold tracking-wide mb-1.5">{label}</label>
      {children}
      {hint && !error && <p className="text-fg-subtle text-xs mt-1">{hint}</p>}
      {error && (
        <p className="text-danger-fg text-sm flex items-center gap-1 mt-1" role="alert">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  )
}
