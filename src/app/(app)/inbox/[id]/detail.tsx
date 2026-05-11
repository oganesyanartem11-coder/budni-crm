'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles, Send, X, RotateCcw, AlertTriangle, MessageSquare, User2 } from 'lucide-react'
import { toast } from 'sonner'
import { ensureDraftReply, sendReplyAndResolve, resolveWithoutReply, reopenInboxItem } from '../actions'
import { formatDateShort, formatTime } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import type { BotMessageDirection, InboxItemReason, InboxItemPriority, InboxItemStatus, BotConversationStatus } from '@prisma/client'

interface InboxItemSerialized {
  id: string
  status: InboxItemStatus
  reason: InboxItemReason
  priority: InboxItemPriority
  humanReason: string | null
  clientMessage: string | null
  draftReply: string | null
  managerReply: string | null
  parsedJson: unknown
  clientStatsSnapshot: unknown
  createdAt: Date | string
  resolvedAt: Date | string | null
  client: { id: string; name: string; maxChatId: string | null }
  conversation: {
    id: string
    deliveryDate: Date | string
    status: BotConversationStatus
    messages: Array<{
      id: string
      direction: BotMessageDirection
      text: string
      createdAt: Date | string
      toneLabel: string | null
    }>
  } | null
  resolvedBy: { id: string; name: string } | null
}

const REASON_LABELS: Record<InboxItemReason, string> = {
  NEW_CLIENT: 'Новый клиент',
  ANOMALY_HISTORICAL: 'Отклонение от нормы',
  ANOMALY_THRESHOLD: 'Подозрительное число',
  ANOMALY_LLM_CONFIDENCE: 'LLM не уверен',
  NON_NUMERIC: 'Не цифра',
  CANCELLATION_INTENT: 'Отмена',
  POST_CUTOFF: 'После cut-off',
}

export function InboxItemDetail({ item }: { item: InboxItemSerialized }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [replyText, setReplyText] = useState(item.draftReply ?? '')
  const [contextOpen, setContextOpen] = useState(false)

  const isResolved = item.status !== 'OPEN'
  const messages = item.conversation?.messages ?? []
  const hasNoConversation = !item.conversation

  function handleGenerate() {
    startTransition(async () => {
      const r = await ensureDraftReply(item.id)
      if (r.ok) {
        setReplyText(r.data.draft)
        toast.success('Draft готов — проверь и отправь')
      } else {
        toast.error(r.error)
      }
    })
  }

  function handleSend() {
    const text = replyText.trim()
    if (!text) {
      toast.error('Текст ответа пуст')
      return
    }
    if (!confirm(`Отправить клиенту «${item.client.name}»?\n\n${text}`)) return
    startTransition(async () => {
      const r = await sendReplyAndResolve(item.id, text)
      if (r.ok) {
        toast.success('Отправлено и закрыто')
        router.push('/inbox')
      } else {
        toast.error(r.error)
      }
    })
  }

  function handleClose() {
    if (!confirm('Закрыть без ответа?')) return
    startTransition(async () => {
      const r = await resolveWithoutReply(item.id)
      if (r.ok) {
        toast.success('Закрыто')
        router.push('/inbox')
      } else {
        toast.error(r.error)
      }
    })
  }

  function handleReopen() {
    startTransition(async () => {
      const r = await reopenInboxItem(item.id)
      if (r.ok) {
        toast.success('Открыто заново')
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <div className="space-y-5">
      
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center px-2.5 py-1 rounded-pill bg-neutral-bg text-neutral-fg text-xs font-medium">
          {REASON_LABELS[item.reason]}
        </span>
        {item.priority === 'HIGH' && (
          <span className="inline-flex items-center px-2.5 py-1 rounded-pill bg-danger-bg text-danger-fg text-xs font-semibold">
            HIGH
          </span>
        )}
        {isResolved && (
          <span className="inline-flex items-center px-2.5 py-1 rounded-pill bg-success-bg text-success-fg text-xs font-medium">
            {item.status === 'RESOLVED_SENT' ? 'Ответили' : 'Закрыто без ответа'}
          </span>
        )}
        {item.humanReason && (
          <p className="text-xs text-fg-muted">{item.humanReason}</p>
        )}
      </div>

      
      {isResolved && (
        <div className="rounded-2xl bg-success-bg/30 border border-success/20 p-4 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm text-success-fg">
            Закрыт {item.resolvedAt ? formatDateShort(new Date(item.resolvedAt)) : ''}
            {item.resolvedBy ? `, менеджер: ${item.resolvedBy.name}` : ''}
          </p>
          <button
            type="button"
            onClick={handleReopen}
            disabled={isPending}
            className="px-3 py-1.5 rounded-pill border border-border-strong bg-surface text-fg text-xs font-medium hover:bg-bg transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Открыть заново
          </button>
        </div>
      )}

      
      {(!!item.clientStatsSnapshot || !!item.parsedJson) && (
        <div className="rounded-2xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
          <button
            type="button"
            onClick={() => setContextOpen((v) => !v)}
            className="w-full px-4 py-3 flex items-center justify-between hover:bg-bg/30 transition-colors"
          >
            <span className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-fg-muted" />
              Контекст для менеджера
            </span>
            <span className="text-xs text-fg-muted">{contextOpen ? '▲' : '▼'}</span>
          </button>
          {contextOpen && (
            <div className="px-4 py-3 border-t border-border space-y-3 text-sm">
              {item.clientStatsSnapshot ? (
                <div>
                  <p className="text-xs uppercase tracking-wider text-fg-muted mb-1">Статистика клиента</p>
                  <pre className="text-xs bg-bg/40 rounded-xl p-3 overflow-x-auto">
                    {JSON.stringify(item.clientStatsSnapshot, null, 2)}
                  </pre>
                </div>
              ) : null}
              {item.parsedJson ? (
                <div>
                  <p className="text-xs uppercase tracking-wider text-fg-muted mb-1">Разбор LLM</p>
                  <pre className="text-xs bg-bg/40 rounded-xl p-3 overflow-x-auto">
                    {JSON.stringify(item.parsedJson, null, 2)}
                  </pre>
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      
      <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="flex items-center gap-2 mb-4">
          <MessageSquare className="w-4 h-4 text-fg-muted" />
          <h3 className="text-base font-semibold">Переписка</h3>
        </div>

        {hasNoConversation ? (
          <div className="rounded-xl bg-bg/40 p-3 text-sm">
            <p className="text-xs text-fg-muted mb-1">{formatDateShort(new Date(item.createdAt))}</p>
            <p>{item.clientMessage ?? '(нет текста)'}</p>
          </div>
        ) : messages.length === 0 ? (
          <p className="text-sm text-fg-muted">Сообщений нет</p>
        ) : (
          <div className="space-y-2">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} clientName={item.client.name} />
            ))}
          </div>
        )}
      </div>

      
      {!isResolved && (
        <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h3 className="text-base font-semibold">Ответ</h3>
            {!item.draftReply && (
              <button
                type="button"
                onClick={handleGenerate}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill border border-border-strong bg-surface text-fg text-xs font-medium hover:bg-bg transition-colors disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {isPending ? 'Генерируем…' : 'Сгенерировать draft'}
              </button>
            )}
          </div>

          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            disabled={isPending}
            rows={4}
            placeholder={item.draftReply ? '' : 'Нажми «Сгенерировать draft» или впиши ответ вручную'}
            className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm resize-y"
          />

          {!item.client.maxChatId && (
            <p className="text-xs text-warning-fg mt-2">
              ⚠️ У клиента не задан maxChatId — отправка не сработает. Привяжите chat_id в карточке клиента.
            </p>
          )}

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <button
              type="button"
              onClick={handleSend}
              disabled={isPending || !replyText.trim() || !item.client.maxChatId}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-pill bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              Одобрить и отправить
            </button>
            <button
              type="button"
              onClick={handleClose}
              disabled={isPending}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-pill border border-border-strong bg-surface text-fg text-sm hover:bg-bg disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" />
              Закрыть без ответа
            </button>
          </div>
        </div>
      )}

      
      {isResolved && item.managerReply && (
        <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
          <p className="text-xs uppercase tracking-wider text-fg-muted mb-2">Отправлено менеджером</p>
          <p className="text-sm whitespace-pre-wrap">{item.managerReply}</p>
        </div>
      )}
    </div>
  )
}

function MessageBubble({
  message,
  clientName,
}: {
  message: { direction: BotMessageDirection; text: string; createdAt: Date | string; toneLabel: string | null }
  clientName: string
}) {
  const isClient = message.direction === 'IN'
  const isBot = message.direction === 'OUT'
  const author = isClient ? clientName : isBot ? 'Бот' : 'Менеджер'

  return (
    <div className={cn('flex flex-col', isClient ? 'items-start' : 'items-end')}>
      <div className={cn('max-w-[80%] rounded-2xl px-3 py-2', isClient ? 'bg-bg/60' : isBot ? 'bg-info-bg/50' : 'bg-accent text-accent-fg')}>
        <p className="text-xs opacity-70 mb-0.5 flex items-center gap-1">
          {isClient && <User2 className="w-3 h-3" />}
          {author}
          {message.toneLabel && message.toneLabel !== 'neutral' && (
            <span className="ml-1 italic">· {message.toneLabel}</span>
          )}
        </p>
        <p className="text-sm whitespace-pre-wrap">{message.text}</p>
      </div>
      <p className="text-[10px] text-fg-subtle mt-0.5 px-1">
        {formatTime(new Date(message.createdAt))}
      </p>
    </div>
  )
}
