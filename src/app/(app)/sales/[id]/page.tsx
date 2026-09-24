import { notFound } from 'next/navigation'
import { requireRole } from '@/lib/auth/current-user'
import { getLeadById, getSalesAssignees } from '@/lib/db/queries/sales'
import { SALES_ROLES } from '@/lib/sales/labels'
import { LeadCard } from './lead-card'

/**
 * Sprint 8.0 «Продажи»: карточка заявки. `now` фиксируется на сервере и уходит
 * пропом: сроки задач («сегодня 14:30», «просрочено 2 ч») совпадают при SSR и
 * гидрации.
 */

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function LeadPage({ params }: PageProps) {
  await requireRole([...SALES_ROLES])
  const { id } = await params

  const [lead, assignees] = await Promise.all([getLeadById(id), getSalesAssignees()])
  if (!lead) notFound()

  const now = new Date()

  return <LeadCard lead={lead} assignees={assignees} now={now} />
}
