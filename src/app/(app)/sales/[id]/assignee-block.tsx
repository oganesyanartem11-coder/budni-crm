'use client'

import { useId } from 'react'
import { Loader2 } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CARD_CLASS, SECTION_TITLE_CLASS, SELECT_TRIGGER_CLASS } from '@/components/sales/styles'
import { useSalesMutation } from '@/components/sales/use-sales-mutation'
import type { LeadDetail, SalesAssignee } from '@/lib/sales/types'
import { assignLead } from '../actions'

const NOBODY = '__nobody__'

/** «Ответственный» — рендерится, только если в команде продаж больше одного человека. */
export function AssigneeBlock({ lead, assignees }: { lead: LeadDetail; assignees: SalesAssignee[] }) {
  const id = useId()
  const { run, isPending } = useSalesMutation()
  const current = lead.assignedTo?.id ?? NOBODY
  // Ответственный мог выпасть из списка (деактивирован) — показываем его всё равно.
  const options =
    lead.assignedTo && !assignees.some((a) => a.id === lead.assignedTo?.id)
      ? [...assignees, { id: lead.assignedTo.id, name: lead.assignedTo.name }]
      : assignees

  function handleChange(value: string) {
    if (value === current) return
    const userId = value === NOBODY ? null : value
    const name = options.find((a) => a.id === userId)?.name
    run(() => assignLead({ leadId: lead.id, userId }), {
      success: name ? `Ответственный: ${name}` : 'Ответственный снят',
    })
  }

  return (
    <section aria-labelledby={`${id}-title`} className={CARD_CLASS}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${id}-title`} className={SECTION_TITLE_CLASS}>
          <label htmlFor={`${id}-select`}>Ответственный</label>
        </h2>
        {isPending && <Loader2 className="size-4 animate-spin text-fg-subtle" aria-hidden="true" />}
      </div>
      <div className="mt-3">
        <Select value={current} onValueChange={handleChange} disabled={isPending}>
          <SelectTrigger id={`${id}-select`} className={SELECT_TRIGGER_CLASS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NOBODY} className="min-h-11">
              Не назначен
            </SelectItem>
            {options.map((a) => (
              <SelectItem key={a.id} value={a.id} className="min-h-11">
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  )
}
