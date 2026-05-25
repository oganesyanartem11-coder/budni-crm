'use client'

import { useTransition } from 'react'
import { resolveError, reopenError } from '../actions'

interface Props {
  id: string
  resolved: boolean
}

export function ErrorActionsForm({ id, resolved }: Props) {
  const [pending, startTransition] = useTransition()

  function onClick(): void {
    startTransition(async () => {
      const res = resolved ? await reopenError(id) : await resolveError(id)
      if (!res.ok && res.error) {
        // eslint-disable-next-line no-alert
        alert(res.error)
      }
    })
  }

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="px-5 py-2 rounded-full bg-fg text-bg text-sm font-medium hover:opacity-90 disabled:opacity-50"
      >
        {pending
          ? '…'
          : resolved
            ? 'Переоткрыть'
            : 'Отметить решённой'}
      </button>
    </div>
  )
}
