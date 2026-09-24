'use client'

import Link from 'next/link'
import { Archive, ArchiveRestore, ArrowLeft, Loader2 } from 'lucide-react'
import { CAPSULE_OUTLINE } from '@/components/sales/styles'
import { useSalesMutation } from '@/components/sales/use-sales-mutation'
import { useTaskCompletion } from '@/components/sales/use-task-completion'
import type { LeadDetail, SalesAssignee } from '@/lib/sales/types'
import { formatMskDateTimeShort } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import { archiveLead, unarchiveLead } from '../actions'
import { AssigneeBlock } from './assignee-block'
import { LeadFieldsBlock } from './lead-fields-block'
import { LeadHeader } from './lead-header'
import { LeadHistory } from './lead-history'
import { StageBlock } from './stage-block'
import { TasksBlock } from './tasks-block'

/**
 * Sprint 8.0 «Продажи»: карточка заявки /sales/[id]. Одна колонка (mobile-first):
 * шапка → стадия → следующий шаг → поля → ответственный → история → архив.
 * NextStepDialog живёт здесь (в корне), чтобы пережить исчезновение задачи
 * из списка после revalidatePath.
 */

interface LeadCardProps {
  lead: LeadDetail
  assignees: SalesAssignee[]
  now: Date
}

export function LeadCard({ lead, assignees, now }: LeadCardProps) {
  const { complete, pendingTaskId, dialog } = useTaskCompletion()

  return (
    <div className="max-w-3xl space-y-4">
      <Link
        href="/sales"
        className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-pill px-2 text-sm text-fg-muted transition-colors hover:text-fg-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [touch-action:manipulation]"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Все заявки
      </Link>

      {lead.archivedAt && (
        <p className="flex items-center gap-2 rounded-xl bg-neutral-bg px-3 py-2 text-sm text-neutral-fg">
          <Archive className="size-4 shrink-0" aria-hidden="true" />
          Заявка в архиве с {formatMskDateTimeShort(lead.archivedAt)}
        </p>
      )}

      <LeadHeader lead={lead} />
      <StageBlock lead={lead} />
      <TasksBlock lead={lead} now={now} onComplete={complete} pendingTaskId={pendingTaskId} />
      <LeadFieldsBlock lead={lead} />
      {assignees.length > 1 && <AssigneeBlock lead={lead} assignees={assignees} />}
      <LeadHistory lead={lead} />
      <ArchiveButton leadId={lead.id} archived={lead.archivedAt !== null} />

      {dialog}
    </div>
  )
}

function ArchiveButton({ leadId, archived }: { leadId: string; archived: boolean }) {
  const { run, isPending } = useSalesMutation()

  return (
    <div className="flex justify-center pt-2 pb-4">
      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          archived
            ? run(() => unarchiveLead(leadId), { success: 'Заявка возвращена из архива' })
            : run(() => archiveLead(leadId), { success: 'Заявка в архиве' })
        }
        className={cn(CAPSULE_OUTLINE, 'text-fg-muted')}
      >
        {isPending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : archived ? (
          <ArchiveRestore className="size-4" aria-hidden="true" />
        ) : (
          <Archive className="size-4" aria-hidden="true" />
        )}
        {archived ? 'Вернуть из архива' : 'В архив'}
      </button>
    </div>
  )
}
