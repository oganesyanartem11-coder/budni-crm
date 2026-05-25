import Link from 'next/link'
import { ArrowLeft, Bug } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { formatDateTimeMsk } from '@/lib/utils/format'

type StatusFilter = 'active' | 'resolved' | 'all'
type LevelFilter = 'error' | 'warn' | 'fatal' | 'all'

interface SearchParamsShape {
  status?: string
  level?: string
  page?: string
}

const PAGE_SIZE = 50

function parseStatus(s: string | undefined): StatusFilter {
  if (s === 'resolved' || s === 'all') return s
  return 'active'
}

function parseLevel(s: string | undefined): LevelFilter {
  if (s === 'warn' || s === 'fatal' || s === 'all') return s
  return 'all'
}

function parsePage(s: string | undefined): number {
  const n = Number.parseInt(s ?? '1', 10)
  if (!Number.isFinite(n) || n < 1) return 1
  return n
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function levelBadgeClass(level: string): string {
  if (level === 'fatal') return 'bg-red-100 text-red-700 border-red-200'
  if (level === 'warn') return 'bg-yellow-100 text-yellow-700 border-yellow-200'
  return 'bg-orange-100 text-orange-700 border-orange-200'
}

export default async function ErrorsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsShape>
}) {
  await requireRole(['ADMIN'])

  const sp = await searchParams
  const status = parseStatus(sp.status)
  const level = parseLevel(sp.level)
  const page = parsePage(sp.page)

  const where: {
    resolvedAt?: { not: null } | null
    level?: string
  } = {}
  if (status === 'active') where.resolvedAt = null
  else if (status === 'resolved') where.resolvedAt = { not: null }
  if (level !== 'all') where.level = level

  const [errors, total] = await Promise.all([
    prisma.errorLog.findMany({
      where,
      orderBy: { lastSeenAt: 'desc' },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
      select: {
        id: true,
        message: true,
        level: true,
        count: true,
        url: true,
        lastSeenAt: true,
        resolvedAt: true,
        environment: true,
      },
    }),
    prisma.errorLog.count({ where }),
  ])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function buildLink(overrides: { status?: StatusFilter; level?: LevelFilter; page?: number }): string {
    const params = new URLSearchParams()
    const nextStatus = overrides.status ?? status
    const nextLevel = overrides.level ?? level
    const nextPage = overrides.page ?? 1
    if (nextStatus !== 'active') params.set('status', nextStatus)
    if (nextLevel !== 'all') params.set('level', nextLevel)
    if (nextPage > 1) params.set('page', String(nextPage))
    const qs = params.toString()
    return qs ? `/settings/errors?${qs}` : '/settings/errors'
  }

  return (
    <>
      <div className="mb-6">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К настройкам
        </Link>
      </div>

      <PageHeader
        title="Ошибки"
        subtitle={`Всего по фильтру: ${total}`}
      />

      <div className="flex flex-wrap gap-2 mb-4 text-sm">
        <span className="text-fg-muted">Статус:</span>
        {(['active', 'resolved', 'all'] as StatusFilter[]).map((s) => (
          <Link
            key={s}
            href={buildLink({ status: s, page: 1 })}
            className={`px-3 py-1 rounded-full border ${
              status === s
                ? 'bg-fg text-bg border-fg'
                : 'bg-surface border-border text-fg-muted hover:text-fg'
            }`}
          >
            {s === 'active' ? 'Активные' : s === 'resolved' ? 'Закрытые' : 'Все'}
          </Link>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-6 text-sm">
        <span className="text-fg-muted">Уровень:</span>
        {(['all', 'error', 'warn', 'fatal'] as LevelFilter[]).map((l) => (
          <Link
            key={l}
            href={buildLink({ level: l, page: 1 })}
            className={`px-3 py-1 rounded-full border ${
              level === l
                ? 'bg-fg text-bg border-fg'
                : 'bg-surface border-border text-fg-muted hover:text-fg'
            }`}
          >
            {l === 'all' ? 'Все' : l}
          </Link>
        ))}
      </div>

      {errors.length === 0 ? (
        <div className="rounded-2xl bg-surface border border-border p-8 text-center text-fg-muted">
          <Bug className="w-8 h-8 mx-auto mb-2 opacity-40" strokeWidth={1.5} />
          Ошибок по этому фильтру нет.
        </div>
      ) : (
        <div className="rounded-2xl bg-surface border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg text-fg-muted">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Когда</th>
                <th className="text-left px-4 py-2 font-medium">Сообщение</th>
                <th className="text-right px-4 py-2 font-medium">Кол-во</th>
                <th className="text-left px-4 py-2 font-medium">Уровень</th>
                <th className="text-left px-4 py-2 font-medium">URL</th>
                <th className="text-left px-4 py-2 font-medium">Статус</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((e) => (
                <tr key={e.id} className="border-t border-border hover:bg-bg/50">
                  <td className="px-4 py-2 text-fg-muted whitespace-nowrap">
                    <Link href={`/settings/errors/${e.id}`} className="hover:underline">
                      {formatDateTimeMsk(e.lastSeenAt)}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <Link href={`/settings/errors/${e.id}`} className="hover:underline">
                      {truncate(e.message, 80)}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{e.count}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`px-2 py-0.5 rounded-full border text-xs ${levelBadgeClass(e.level)}`}
                    >
                      {e.level}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-fg-muted">{e.url ? truncate(e.url, 40) : '—'}</td>
                  <td className="px-4 py-2">
                    {e.resolvedAt ? (
                      <span className="px-2 py-0.5 rounded-full border bg-green-100 text-green-700 border-green-200 text-xs">
                        закрыта
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full border bg-bg text-fg-muted border-border text-xs">
                        активна
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm">
          <div className="text-fg-muted">
            Стр. {page} из {totalPages}
          </div>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={buildLink({ page: page - 1 })}
                className="px-3 py-1 rounded-full border border-border bg-surface hover:border-border-strong"
              >
                ← Назад
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={buildLink({ page: page + 1 })}
                className="px-3 py-1 rounded-full border border-border bg-surface hover:border-border-strong"
              >
                Вперёд →
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  )
}
