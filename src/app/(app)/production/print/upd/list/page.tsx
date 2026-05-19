import Link from 'next/link'
import { ArrowLeft, Printer } from 'lucide-react'
import { prisma } from '@/lib/db/prisma'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { listGeneratedUpd } from '../actions'
import { formatDateNumeric, formatMoney } from '@/lib/utils/format'

interface PageProps {
  searchParams: Promise<{ dateFrom?: string; dateTo?: string; clientId?: string }>
}

export default async function UpdListPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])
  const params = await searchParams

  const [res, clients] = await Promise.all([
    listGeneratedUpd({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      clientId: params.clientId,
    }),
    prisma.client.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])

  if (!res.ok) {
    return (
      <div className="max-w-3xl mx-auto">
        <Link href="/production/print" className="inline-flex items-center gap-1.5 text-sm text-fg-muted mb-4">
          <ArrowLeft className="w-4 h-4" /> К меню печати
        </Link>
        <div className="bg-surface border border-border rounded-2xl p-6 text-danger-fg">
          {res.error}
        </div>
      </div>
    )
  }

  const { items, truncated } = res.data

  return (
    <>
      <div className="mb-6">
        <Link
          href="/production/print"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К меню печати
        </Link>
      </div>

      <PageHeader
        title="Выписанные УПД"
        subtitle="Перепечать ранее сформированных документов. Номера не меняются."
      />

      <form
        method="get"
        className="mb-5 rounded-2xl bg-surface border border-border p-4 grid grid-cols-1 md:grid-cols-4 gap-3"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <div>
          <label className="block text-xs text-fg-muted mb-1">Дата отгрузки от</label>
          <input
            type="date"
            name="dateFrom"
            defaultValue={params.dateFrom ?? ''}
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-fg-muted mb-1">до</label>
          <input
            type="date"
            name="dateTo"
            defaultValue={params.dateTo ?? ''}
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-fg-muted mb-1">Клиент</label>
          <select
            name="clientId"
            defaultValue={params.clientId ?? ''}
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm"
          >
            <option value="">Все клиенты</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="px-4 py-2 rounded-pill bg-accent text-accent-fg text-sm font-medium hover:opacity-90"
          >
            Применить
          </button>
          <Link
            href="/production/print/upd/list"
            className="px-4 py-2 rounded-pill border border-border text-sm hover:bg-bg-subtle"
          >
            Сброс
          </Link>
        </div>
      </form>

      {items.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-8 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          Нет выписанных УПД по этим фильтрам.
        </div>
      ) : (
        <div className="rounded-2xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
          <table className="w-full text-sm">
            <thead className="bg-bg text-fg-muted text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left p-3">Номер</th>
                <th className="text-left p-3">Дата отгрузки</th>
                <th className="text-left p-3">Юрлицо</th>
                <th className="text-left p-3">Клиент / точка</th>
                <th className="text-right p-3">Сумма</th>
                <th className="text-right p-3 w-1"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-t border-border">
                  <td className="p-3 font-medium tabular-nums">{it.documentNumber}</td>
                  <td className="p-3 tabular-nums">{formatDateNumeric(new Date(it.deliveryDateIso))}</td>
                  <td className="p-3 text-fg-muted">{it.ourLegalEntityShortName}</td>
                  <td className="p-3">
                    <div>{it.clientName}</div>
                    <div className="text-xs text-fg-muted">{it.locationName}</div>
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {formatMoney(it.totalAmount, { withKopecks: true })}
                  </td>
                  <td className="p-3 text-right">
                    <Link
                      href={`/production/print/upd/pdf?id=${it.id}`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill bg-accent text-accent-fg text-xs font-medium hover:opacity-90"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      Печать
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {truncated && (
        <p className="mt-4 text-xs text-fg-muted">
          Показаны последние 100 документов. Уточните фильтры, чтобы найти более старые.
        </p>
      )}
    </>
  )
}
