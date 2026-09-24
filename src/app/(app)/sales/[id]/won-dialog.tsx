'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Building2, Check, Loader2, Plus, Search } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SalesField } from '@/components/sales/form-field'
import {
  CAPSULE_OUTLINE,
  CAPSULE_PRIMARY,
  DIALOG_CONTENT_CLASS,
  INPUT_CLASS,
} from '@/components/sales/styles'
import { parseRubAmount } from '@/components/sales/utils'
import type { ClientOption } from '@/lib/sales/types'
import { cn } from '@/lib/utils/cn'
import { linkLeadToClient, searchClientsForLink, updateLeadFields } from '../actions'

interface WonDialogProps {
  leadId: string
  /** Уже сохранённый ориентир выручки — предзаполняем поле. */
  dealAmount: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * «✅ Стал клиентом»: ориентир выручки (необязательно) + создать нового
 * клиента (/clients/new?leadId=) или привязать к существующему.
 */
export function WonDialog({ leadId, dealAmount, open, onOpenChange }: WonDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG_CONTENT_CLASS}>
        {open && (
          <WonDialogBody leadId={leadId} dealAmount={dealAmount} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function WonDialogBody({
  leadId,
  dealAmount,
  onClose,
}: {
  leadId: string
  dealAmount: number | null
  onClose: () => void
}) {
  const router = useRouter()
  const ids = useId()
  const [isPending, startTransition] = useTransition()
  const [amount, setAmount] = useState(dealAmount !== null ? String(dealAmount) : '')
  const [amountError, setAmountError] = useState<string | null>(null)
  const [mode, setMode] = useState<'choose' | 'link'>('choose')

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ClientOption[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<ClientOption | null>(null)
  const requestRef = useRef(0)

  // Поиск клиентов: сразу при открытии режима, дальше — debounce 300 мс.
  useEffect(() => {
    if (mode !== 'link') return
    const requestId = ++requestRef.current
    const timer = setTimeout(
      async () => {
        setSearching(true)
        try {
          const list = await searchClientsForLink(query.trim())
          if (requestId === requestRef.current) setResults(list)
        } catch {
          if (requestId === requestRef.current) {
            setResults([])
            toast.error('Не удалось загрузить клиентов')
          }
        } finally {
          if (requestId === requestRef.current) setSearching(false)
        }
      },
      query ? 300 : 0
    )
    return () => clearTimeout(timer)
  }, [mode, query])

  /** Разбор суммы; undefined — ошибка (уже показана). */
  function readAmount(): number | null | undefined {
    const value = parseRubAmount(amount)
    if (value === undefined) setAmountError('Сумма — число, например 120 000')
    else setAmountError(null)
    return value
  }

  /** Ориентир выручки сохраняем до ухода/привязки; пусто — не трогаем. */
  async function saveAmount(value: number | null): Promise<boolean> {
    if (value === null || value === dealAmount) return true
    const r = await updateLeadFields({ leadId, dealAmount: value })
    if (!r.ok) {
      toast.error(r.error)
      return false
    }
    return true
  }

  function createNewClient() {
    const value = readAmount()
    if (value === undefined) return
    startTransition(async () => {
      try {
        if (!(await saveAmount(value))) return
        router.push(`/clients/new?leadId=${encodeURIComponent(leadId)}`)
      } catch {
        toast.error('Не удалось сохранить. Проверь связь и попробуй ещё раз')
      }
    })
  }

  function linkSelected() {
    if (!selected) return
    const value = readAmount()
    if (value === undefined) return
    startTransition(async () => {
      try {
        if (!(await saveAmount(value))) return
        const r = await linkLeadToClient({ leadId, clientId: selected.id })
        if (!r.ok) {
          toast.error(r.error)
          return
        }
        toast.success(`Заявка привязана к клиенту «${r.data.clientName}»`)
        onClose()
        router.refresh()
      } catch {
        toast.error('Не удалось привязать. Проверь связь и попробуй ещё раз')
      }
    })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-lg font-bold">Стал клиентом</DialogTitle>
        <DialogDescription>Заведи клиента в CRM или привяжи заявку к существующему.</DialogDescription>
      </DialogHeader>

      <SalesField
        label="Выручка в месяц, ₽ (ориентир, необязательно)"
        htmlFor={`${ids}-amount`}
        error={amountError}
      >
        <input
          id={`${ids}-amount`}
          type="text"
          inputMode="decimal"
          value={amount}
          disabled={isPending}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Например, 120 000"
          aria-invalid={!!amountError}
          className={cn(INPUT_CLASS, 'tabular-nums', amountError && 'border-danger')}
        />
      </SalesField>

      {mode === 'link' && (
        <div className="space-y-2">
          <label htmlFor={`${ids}-client-search`} className="sr-only">
            Поиск клиента
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle"
              aria-hidden="true"
            />
            <input
              id={`${ids}-client-search`}
              type="search"
              autoComplete="off"
              enterKeyHint="search"
              value={query}
              disabled={isPending}
              onChange={(e) => {
                setQuery(e.target.value)
                setSelected(null)
              }}
              placeholder="Название клиента"
              className={cn(INPUT_CLASS, 'pl-9')}
            />
            {searching && (
              <Loader2
                className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-fg-subtle"
                aria-hidden="true"
              />
            )}
          </div>

          <div className="max-h-60 overflow-y-auto rounded-xl border border-border" aria-live="polite">
            {results === null ? (
              <p className="px-3 py-3 text-sm text-fg-muted">Загружаем клиентов…</p>
            ) : results.length === 0 ? (
              <p className="px-3 py-3 text-sm text-fg-muted">Никого не нашли</p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {results.map((client) => {
                  const active = selected?.id === client.id
                  return (
                    <li key={client.id}>
                      <button
                        type="button"
                        aria-pressed={active}
                        disabled={isPending}
                        onClick={() => setSelected(client)}
                        className={cn(
                          'flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors [touch-action:manipulation]',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset',
                          active ? 'bg-primary text-primary-foreground' : 'text-fg hover:bg-surface-2'
                        )}
                      >
                        <Building2 className="size-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{client.name}</span>
                        {active && <Check className="size-4 shrink-0" aria-hidden="true" />}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      <DialogFooter className="bg-surface-2">
        {mode === 'choose' ? (
          <>
            <button
              type="button"
              disabled={isPending}
              onClick={() => setMode('link')}
              className={CAPSULE_OUTLINE}
            >
              <Search className="size-4" aria-hidden="true" />
              Привязать к существующему
            </button>
            <button type="button" disabled={isPending} onClick={createNewClient} className={CAPSULE_PRIMARY}>
              {isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="size-4" aria-hidden="true" />
              )}
              Создать нового клиента
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                setMode('choose')
                setSelected(null)
              }}
              className={CAPSULE_OUTLINE}
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              Назад
            </button>
            <button
              type="button"
              disabled={isPending || !selected}
              onClick={linkSelected}
              className={CAPSULE_PRIMARY}
            >
              {isPending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              <span className="min-w-0 truncate">
                {selected ? `Привязать к «${selected.name}»` : 'Выбери клиента'}
              </span>
            </button>
          </>
        )}
      </DialogFooter>
    </>
  )
}
