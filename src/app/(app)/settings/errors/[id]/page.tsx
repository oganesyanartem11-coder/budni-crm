import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { formatDateTimeMsk } from '@/lib/utils/format'
import { ErrorActionsForm } from './form'

function levelBadgeClass(level: string): string {
  if (level === 'fatal') return 'bg-red-100 text-red-700 border-red-200'
  if (level === 'warn') return 'bg-yellow-100 text-yellow-700 border-yellow-200'
  return 'bg-orange-100 text-orange-700 border-orange-200'
}

export default async function ErrorDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireRole(['ADMIN'])
  const { id } = await params

  const record = await prisma.errorLog.findUnique({ where: { id } })
  if (!record) notFound()

  const resolvedByUser = record.resolvedBy
    ? await prisma.user.findUnique({
        where: { id: record.resolvedBy },
        select: { name: true, role: true },
      })
    : null

  const payloadJson = record.payload
    ? JSON.stringify(record.payload, null, 2)
    : null

  return (
    <>
      <div className="mb-6">
        <Link
          href="/settings/errors"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К списку ошибок
        </Link>
      </div>

      <PageHeader title="Подробности ошибки" subtitle={record.fingerprint} />

      <div className="space-y-4">
        <div className="rounded-2xl bg-surface border border-border p-5 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`px-2 py-0.5 rounded-full border text-xs ${levelBadgeClass(record.level)}`}
            >
              {record.level}
            </span>
            <span className="px-2 py-0.5 rounded-full border bg-bg text-fg-muted border-border text-xs">
              {record.environment}
            </span>
            <span className="text-sm text-fg-muted">×{record.count}</span>
            {record.resolvedAt && (
              <span className="px-2 py-0.5 rounded-full border bg-green-100 text-green-700 border-green-200 text-xs">
                закрыта
              </span>
            )}
          </div>

          <p className="font-medium text-base break-words">{record.message}</p>

          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <div>
              <dt className="text-fg-muted inline">Впервые: </dt>
              <dd className="inline">{formatDateTimeMsk(record.firstSeenAt)}</dd>
            </div>
            <div>
              <dt className="text-fg-muted inline">Последний раз: </dt>
              <dd className="inline">{formatDateTimeMsk(record.lastSeenAt)}</dd>
            </div>
            {record.url && (
              <div className="sm:col-span-2">
                <dt className="text-fg-muted inline">URL: </dt>
                <dd className="inline break-all">
                  {record.method ? `${record.method} ` : ''}
                  {record.url}
                </dd>
              </div>
            )}
            {record.userId && (
              <div>
                <dt className="text-fg-muted inline">Юзер: </dt>
                <dd className="inline">
                  {record.userId} ({record.userRole ?? '—'})
                </dd>
              </div>
            )}
            {record.resolvedAt && (
              <div>
                <dt className="text-fg-muted inline">Закрыта: </dt>
                <dd className="inline">
                  {formatDateTimeMsk(record.resolvedAt)}
                  {resolvedByUser && ` (${resolvedByUser.name})`}
                </dd>
              </div>
            )}
          </dl>
        </div>

        {record.stack && (
          <div className="rounded-2xl bg-surface border border-border p-5">
            <h3 className="font-semibold text-sm text-fg-muted uppercase mb-2">Stack</h3>
            <pre className="text-xs overflow-x-auto bg-bg rounded-lg p-3 font-mono whitespace-pre-wrap break-all">
              {record.stack}
            </pre>
          </div>
        )}

        {payloadJson && (
          <div className="rounded-2xl bg-surface border border-border p-5">
            <h3 className="font-semibold text-sm text-fg-muted uppercase mb-2">Payload</h3>
            <pre className="text-xs overflow-x-auto bg-bg rounded-lg p-3 font-mono whitespace-pre-wrap break-all">
              {payloadJson}
            </pre>
          </div>
        )}

        <ErrorActionsForm id={record.id} resolved={Boolean(record.resolvedAt)} />
      </div>
    </>
  )
}
