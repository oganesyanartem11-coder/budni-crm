'use client'

import Link from 'next/link'
import {
  Sparkles,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { PROGRESS_LABELS } from '@/lib/menu-import/progress-labels'
import { StatusChip } from '@/lib/menu-import/status-chip'
import { formatDateLong } from '@/lib/utils/format'
import type { MenuImportProgress, MenuImportSource, MenuStatus } from '@prisma/client'

interface ImportRow {
  id: string
  source: MenuImportSource
  status: MenuStatus
  progress: MenuImportProgress
  createdAt: Date
  reason: string | null
  createdBy: { name: string } | null
  _count: { dishes: number }
}

export function ImportsList({ imports }: { imports: ImportRow[] }) {
  if (imports.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="Импортов пока нет"
        description="Загрузите Excel с меню — AI распознает структуру и составит черновики техкарт."
        cta={
          <Link
            href="/menu/imports/new"
            className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity inline-flex items-center gap-2"
          >
            <Sparkles className="w-4 h-4" />
            Новый импорт
          </Link>
        }
      />
    )
  }

  return (
    <div className="space-y-2">
      {imports.map((imp) => (
        <Link
          key={imp.id}
          href={`/menu/imports/${imp.id}`}
          className="block bg-surface border border-border rounded-2xl p-4 hover:border-fg/20 transition-colors"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <div className="flex items-center gap-4">
            <ProgressIcon progress={imp.progress} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-3 mb-0.5">
                <p className="font-medium text-fg truncate">{formatDateLong(imp.createdAt)}</p>
                <span className="text-xs text-fg-subtle truncate">
                  {imp.createdBy?.name ?? '—'} · {imp.source === 'EXCEL' ? 'Excel' : 'Фото'}
                </span>
              </div>
              <p className="text-sm text-fg-muted">
                {PROGRESS_LABELS[imp.progress]}
                {imp._count.dishes > 0 && ` · ${imp._count.dishes} блюд`}
              </p>
              {imp.progress === 'FAILED' && imp.reason && (
                <p className="text-xs text-danger mt-1 truncate">{imp.reason}</p>
              )}
            </div>
            <StatusChip status={imp.status} className="shrink-0" />
            <ChevronRight className="w-4 h-4 text-fg-subtle shrink-0" />
          </div>
        </Link>
      ))}
    </div>
  )
}

function ProgressIcon({ progress }: { progress: MenuImportProgress }) {
  if (progress === 'READY') return <CheckCircle2 className="w-6 h-6 text-success shrink-0" />
  if (progress === 'FAILED') return <AlertCircle className="w-6 h-6 text-danger shrink-0" />
  return <Loader2 className="w-6 h-6 text-accent shrink-0 animate-spin" />
}
