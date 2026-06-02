'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertCircle, RefreshCw, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { retryRecognition } from '../actions'
import { isAdminLike } from '@/lib/auth/role-helpers'
import type { UserRole } from '@prisma/client'

interface Props {
  invoiceId: string
  errorMessage: string | null
  imageUrl: string | null
  userRole: UserRole
}

export function FailedState({ invoiceId, errorMessage, imageUrl, userRole }: Props) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const canRetry = isAdminLike(userRole) || userRole === 'MANAGER' || userRole === 'CHEF'

  function handleRetry() {
    startTransition(async () => {
      const r = await retryRecognition(invoiceId)
      if (r.ok) {
        toast.success('Запустили распознавание заново')
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <div className="rounded-2xl border border-danger/30 bg-danger/5 p-6 max-w-2xl">
      <div className="flex items-start gap-3 mb-4">
        <AlertCircle className="w-6 h-6 text-danger-fg shrink-0 mt-0.5" />
        <div>
          <p className="font-medium text-fg mb-1">AI не смог распознать поставку</p>
          <p className="text-sm text-fg-muted whitespace-pre-wrap">
            {errorMessage ?? 'Причина неизвестна. Проверьте качество фото.'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        {canRetry && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={isPending}
            className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${isPending ? 'animate-spin' : ''}`} />
            {isPending ? 'Запускаем…' : 'Перераспознать'}
          </button>
        )}
        {imageUrl && (
          <Link
            href={imageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-5 py-2.5 rounded-pill border border-border text-fg text-sm hover:bg-fg/5 transition-colors flex items-center gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            Открыть фото
          </Link>
        )}
      </div>
    </div>
  )
}
