'use client'

import { useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Building2,
  User as UserIcon,
  Pencil,
  Power,
  PowerOff,
  Plus,
} from 'lucide-react'
import { toast } from 'sonner'
import { setLegalEntityActive } from './actions'
import { cn } from '@/lib/utils/cn'
import type { LegalEntityType, VatMode } from '@prisma/client'

type SerializedEntity = {
  id: string
  shortName: string
  fullName: string
  entityType: LegalEntityType
  inn: string
  kpp: string | null
  ogrn: string
  bankName: string
  vatMode: VatMode
  vatRate: number | null
  isActive: boolean
}

interface Props {
  entities: SerializedEntity[]
}

const TYPE_LABEL: Record<LegalEntityType, string> = {
  INDIVIDUAL_ENTREPRENEUR: 'ИП',
  LLC: 'ООО',
}

const TYPE_BADGE_CLASS: Record<LegalEntityType, string> = {
  INDIVIDUAL_ENTREPRENEUR: 'bg-info-bg text-info-fg',
  LLC: 'bg-warning-bg text-warning-fg',
}

function formatVat(mode: VatMode, rate: number | null): string {
  if (mode === 'NONE') return 'Без НДС'
  if (rate === null) return 'НДС'
  // Декимал к целому без .00, иначе с двумя знаками
  const formatted = Number.isInteger(rate) ? String(rate) : rate.toFixed(2)
  return `НДС ${formatted}%`
}

export function LegalEntitiesList({ entities }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function handleToggleActive(entity: SerializedEntity) {
    const next = !entity.isActive
    if (entity.isActive) {
      if (
        !confirm(`Деактивировать «${entity.shortName}»? Юрлицо перестанет быть доступным для новых УПД.`)
      ) {
        return
      }
    }
    startTransition(async () => {
      const result = await setLegalEntityActive(entity.id, next)
      if (result.ok) {
        toast.success(next ? 'Юрлицо активировано' : 'Юрлицо деактивировано')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  if (entities.length === 0) {
    return (
      <div
        className="rounded-2xl bg-surface border border-border p-12 flex flex-col items-center justify-center text-center"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <Building2 className="w-12 h-12 text-fg-subtle mb-4" strokeWidth={1.5} />
        <p className="font-medium text-fg mb-1">Юридических лиц пока нет</p>
        <p className="text-sm text-fg-muted max-w-sm mb-5">
          Добавьте ваше ИП или ООО — это нужно для генерации УПД на отгрузку.
        </p>
        <Link
          href="/settings/legal-entities/new"
          className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity"
        >
          <Plus className="w-4 h-4" />
          Добавить юрлицо
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {entities.map((e) => {
        const Icon = e.entityType === 'LLC' ? Building2 : UserIcon
        return (
          <div
            key={e.id}
            className={cn(
              'rounded-2xl bg-surface border border-border p-5',
              !e.isActive && 'opacity-60'
            )}
            style={{ boxShadow: 'var(--shadow-card)' }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div className="w-10 h-10 rounded-full bg-bg flex items-center justify-center shrink-0">
                  <Icon className="w-5 h-5 text-fg-muted" strokeWidth={1.75} />
                </div>

                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-base truncate">{e.shortName}</h3>
                    <span
                      className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-medium',
                        TYPE_BADGE_CLASS[e.entityType]
                      )}
                    >
                      {TYPE_LABEL[e.entityType]}
                    </span>
                    {!e.isActive && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-medium bg-neutral-bg text-neutral-fg">
                        Архив
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-fg-muted truncate" title={e.fullName}>
                    {e.fullName}
                  </p>
                  <div className="text-xs text-fg-muted flex flex-wrap gap-x-3 gap-y-1">
                    <span>
                      ИНН: <span className="tabular-nums text-fg">{e.inn}</span>
                      {e.kpp && <> · КПП: <span className="tabular-nums text-fg">{e.kpp}</span></>}
                    </span>
                    <span className="truncate">Банк: <span className="text-fg">{e.bankName}</span></span>
                    <span>{formatVat(e.vatMode, e.vatRate)}</span>
                  </div>
                </div>
              </div>

              <div className="inline-flex items-center gap-1.5 shrink-0">
                <Link
                  href={`/settings/legal-entities/${e.id}/edit`}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-pill bg-bg hover:bg-border text-xs text-fg-muted hover:text-fg transition-colors"
                  title="Редактировать"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Изменить
                </Link>
                <button
                  type="button"
                  onClick={() => handleToggleActive(e)}
                  disabled={isPending}
                  title={e.isActive ? 'Деактивировать' : 'Активировать'}
                  className={cn(
                    'inline-flex items-center px-2.5 py-1.5 rounded-pill text-xs transition-colors disabled:opacity-50',
                    e.isActive
                      ? 'bg-bg hover:bg-danger-bg/40 hover:text-danger-fg text-fg-muted'
                      : 'bg-success-bg/40 text-success-fg hover:bg-success-bg'
                  )}
                >
                  {e.isActive ? <PowerOff className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
