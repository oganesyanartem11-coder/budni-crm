'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquare, Save, X } from 'lucide-react'
import { toast } from 'sonner'
import { updateClientMaxChatId } from '../actions'

interface Props {
  clientId: string
  currentValue: string | null
}

export function MaxChatIdSection({ clientId, currentValue }: Props) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(currentValue ?? '')
  const [isPending, startTransition] = useTransition()

  function handleSave() {
    const next = value.trim() || null
    startTransition(async () => {
      const result = await updateClientMaxChatId(clientId, next)
      if (result.ok) {
        toast.success(next ? `Привязан chat_id: ${next}` : 'chat_id отвязан')
        setEditing(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleClear() {
    startTransition(async () => {
      const result = await updateClientMaxChatId(clientId, null)
      if (result.ok) {
        toast.success('chat_id отвязан')
        setValue('')
        setEditing(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div
      className="rounded-2xl bg-surface border border-border p-5 mb-5"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold uppercase tracking-wider text-fg-muted">MAX-бот</h3>
      </div>

      {!editing ? (
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm">
              {currentValue ? (
                <>
                  Привязан chat_id: <span className="font-mono font-medium">{currentValue}</span>
                </>
              ) : (
                <span className="text-fg-muted">chat_id не привязан</span>
              )}
            </p>
            <p className="text-xs text-fg-subtle mt-1">
              Чтобы получить chat_id: попросите клиента написать боту любое сообщение, затем найдите запись
              <span className="font-mono"> [bot] incoming: chat=…</span> в логах Vercel.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="shrink-0 px-3 py-1.5 rounded-pill border border-border-strong bg-surface text-fg text-xs font-medium hover:bg-bg transition-colors"
          >
            {currentValue ? 'Изменить' : 'Привязать'}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            inputMode="numeric"
            pattern="\d*"
            placeholder="123456789"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={isPending}
            className="flex-1 min-w-[160px] px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm font-mono"
          />
          <button
            type="button"
            onClick={handleSave}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-pill bg-accent text-accent-fg text-xs font-medium hover:opacity-90 disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            Сохранить
          </button>
          {currentValue && (
            <button
              type="button"
              onClick={handleClear}
              disabled={isPending}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-pill border border-danger/30 text-danger-fg text-xs font-medium hover:bg-danger-bg/40 disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" />
              Отвязать
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setEditing(false)
              setValue(currentValue ?? '')
            }}
            disabled={isPending}
            className="px-3 py-2 rounded-pill text-fg-muted text-xs hover:text-fg disabled:opacity-50"
          >
            Отмена
          </button>
        </div>
      )}
    </div>
  )
}
