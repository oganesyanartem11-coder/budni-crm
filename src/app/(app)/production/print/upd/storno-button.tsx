'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Ban } from 'lucide-react'
import { toast } from 'sonner'
import { stornoUpd } from './actions'

export function StornoButton({
  updDocumentId,
  documentNumber,
}: {
  updDocumentId: string
  documentNumber: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function handleStorno() {
    if (isPending) return
    // Необратимо: physical delete записи УПД (владелец подтвердил, след не нужен).
    if (!confirm(`Аннулировать УПД ${documentNumber}? Действие необратимо.`)) {
      return
    }
    startTransition(async () => {
      const res = await stornoUpd(updDocumentId)
      if (res.ok) {
        toast.success(`УПД ${res.data.documentNumber} аннулирована`)
        router.refresh()
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <button
      type="button"
      onClick={handleStorno}
      disabled={isPending}
      title="Аннулировать УПД"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill bg-bg hover:bg-danger-bg/40 text-fg-muted hover:text-danger-fg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <Ban className="w-3.5 h-3.5" />
      {isPending ? 'Аннулирую…' : 'Аннулировать'}
    </button>
  )
}
