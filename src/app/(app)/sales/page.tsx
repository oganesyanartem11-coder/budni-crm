import Link from 'next/link'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { CAPSULE_PRIMARY } from '@/components/sales/styles'
import { requireRole } from '@/lib/auth/current-user'
import { getLeads, getSalesToday } from '@/lib/db/queries/sales'
import { SALES_ROLES, parseLeadFilter } from '@/lib/sales/labels'
import { SalesView } from './sales-view'

/**
 * Sprint 8.0 «Продажи»: воронка заявок. Фильтр и поиск — в URL (?filter=, ?q=),
 * `now` фиксируется на сервере и уходит пропом во вьюху, чтобы относительное
 * время («сегодня 14:30», «2 ч назад») совпадало при SSR и гидрации.
 */

interface PageProps {
  searchParams: Promise<{ filter?: string | string[]; q?: string | string[] }>
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default async function SalesPage({ searchParams }: PageProps) {
  await requireRole([...SALES_ROLES])

  const params = await searchParams
  const filter = parseLeadFilter(firstParam(params.filter))
  const q = (firstParam(params.q) ?? '').trim().slice(0, 100)
  const now = new Date()

  const [today, leads] = await Promise.all([
    getSalesToday(now),
    getLeads({ filter, q: q || undefined, now }),
  ])

  return (
    <>
      <PageHeader
        title="Продажи"
        subtitle="Заявки, задачи и напоминания"
        className="mb-6"
        actions={
          <Link href="/sales/new" className={CAPSULE_PRIMARY}>
            <Plus className="size-4" aria-hidden="true" />
            Заявка
          </Link>
        }
      />
      <SalesView today={today} leads={leads} filter={filter} q={q} now={now} />
    </>
  )
}
