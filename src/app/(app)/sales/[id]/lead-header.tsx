'use client'

import { Fragment } from 'react'
import { Mail, Phone } from 'lucide-react'
import { PhoneLink } from '@/components/ui/phone-link'
import { PipelineBadge } from '@/components/sales/pipeline-badge'
import { CAPSULE_OUTLINE, CAPSULE_PRIMARY, CARD_CLASS, META_CHIP } from '@/components/sales/styles'
import { QUIZ_ANSWER_LABELS, formTypeLabel, sourceLabel } from '@/lib/sales/labels'
import type { LeadDetail } from '@/lib/sales/types'
import { formatMskDateTimeShort, formatPhoneLink } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'

/** Значение ответа квиза → строка (массив — через запятую). */
function formatAnswer(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ')
  if (typeof value === 'boolean') return value ? 'да' : 'нет'
  return String(value)
}

export function LeadHeader({ lead }: { lead: LeadDetail }) {
  const company = lead.company?.trim() || null
  const name = lead.name?.trim() || null
  const primary = company || name || lead.phone
  const secondary = company && name ? name : null
  const source = sourceLabel(lead.source)
  const tel = formatPhoneLink(lead.phone)
  const email = lead.email?.trim() || null
  const answers = lead.answers
    ? Object.entries(lead.answers).filter(([, v]) => v !== null && v !== undefined && v !== '')
    : []

  return (
    <section className={CARD_CLASS}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <PipelineBadge status={lead.pipelineStatus} />
        <span className={META_CHIP}>
          <span className="truncate">{formTypeLabel(lead.formType)}</span>
        </span>
        {source && (
          <span className={META_CHIP}>
            <span className="truncate">{source}</span>
          </span>
        )}
      </div>

      <h1 className="mt-3 font-display text-2xl leading-tight font-bold tracking-tight break-words text-fg-strong md:text-3xl">
        {primary}
      </h1>
      {secondary && <p className="mt-1 text-base break-words text-fg-muted">{secondary}</p>}

      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-fg-muted">
        <PhoneLink phone={lead.phone} className="font-medium text-fg tabular-nums" />
        <span aria-hidden="true">·</span>
        <span>создана {formatMskDateTimeShort(lead.createdAt)}</span>
      </p>

      {(tel || email) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {tel && (
            <a href={`tel:${tel}`} className={cn(CAPSULE_PRIMARY, 'flex-1 sm:flex-none')}>
              <Phone className="size-4" aria-hidden="true" />
              Позвонить
            </a>
          )}
          {email && (
            <a href={`mailto:${email}`} className={cn(CAPSULE_OUTLINE, 'flex-1 sm:flex-none')}>
              <Mail className="size-4" aria-hidden="true" />
              Email
            </a>
          )}
        </div>
      )}

      {answers.length > 0 && (
        <div className="mt-4 rounded-xl bg-surface-2 p-3">
          <p className="text-xs font-bold tracking-wide text-fg-muted uppercase">Ответы квиза</p>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            {answers.map(([key, value]) => (
              <Fragment key={key}>
                <dt className="text-fg-muted">{QUIZ_ANSWER_LABELS[key] ?? key}</dt>
                <dd className="font-medium break-words text-fg">{formatAnswer(value)}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}
    </section>
  )
}
