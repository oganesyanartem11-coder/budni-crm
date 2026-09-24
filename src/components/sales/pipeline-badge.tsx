import type { LeadPipelineStatus } from '@prisma/client'
import { StatusBadge } from '@/components/ui/status-badge'
import { PIPELINE_STATUS_RU, PIPELINE_STATUS_VARIANT } from '@/lib/sales/labels'
import { cn } from '@/lib/utils/cn'

/** Чип стадии воронки (цвет — PIPELINE_STATUS_VARIANT, текст — PIPELINE_STATUS_RU). */
export function PipelineBadge({ status, className }: { status: LeadPipelineStatus; className?: string }) {
  return (
    <StatusBadge variant={PIPELINE_STATUS_VARIANT[status]} className={cn('shrink-0 whitespace-nowrap', className)}>
      {PIPELINE_STATUS_RU[status]}
    </StatusBadge>
  )
}
