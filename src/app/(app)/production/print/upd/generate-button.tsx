'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { FileText } from 'lucide-react'
import { toast } from 'sonner'
import { generateAndGetUpdForDate } from './actions'

export function GenerateButton({
  dateIso,
  disabled,
}: {
  dateIso: string
  disabled?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)

  function onClick() {
    if (disabled || pending || busy) return
    setBusy(true)
    startTransition(async () => {
      const res = await generateAndGetUpdForDate(dateIso)
      if (!res.ok) {
        toast.error(res.error)
        setBusy(false)
        return
      }
      const { createdCount, reusedCount, conflicts, printUrl } = res.data
      if (conflicts.length > 0) {
        toast.warning(`УПД сформированы (новых: ${createdCount}, существующих: ${reusedCount}). Конфликтов: ${conflicts.length}.`)
      } else if (createdCount === 0 && reusedCount > 0) {
        toast.success(`Используются ранее сформированные УПД (${reusedCount}).`)
      } else {
        toast.success(`Сформировано УПД: ${createdCount}${reusedCount ? `, переиспользовано: ${reusedCount}` : ''}.`)
      }
      router.push(printUrl)
    })
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending || busy}
      className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <FileText className="w-4 h-4" />
      {pending || busy ? 'Формирую…' : 'Сформировать и печатать'}
    </button>
  )
}
