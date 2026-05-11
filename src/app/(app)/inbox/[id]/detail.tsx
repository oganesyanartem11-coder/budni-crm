'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Sparkles, Send, AlertTriangle, MessageSquare,
  User2, ExternalLink, Phone,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  ensureDraftReply, sendReplyAndResolve, fetchInboxItemFresh,
} from '../actions'
import { formatTime, formatDateShort } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import type {
  BotMessageDirection, InboxItemReason, InboxItemPriority,
  InboxItemStatus, BotConversationStatus,
} from '@prisma/client'

const POLL_INTERVAL_MS = 10_000

interface MessageItem {
  id: string
  direction: BotMessageDirection
  text: string
  createdAt: Date | string
  toneLabel: string | null
}

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
  client: {
    id: string
    name: string
    contactPhone: string | null
    maxChatId: string | null
    maxUsername: string | null
  }
  conversation: {
    id: string
    deliveryDate: Date | string
    status: BotConversationStatus
    messages: MessageItem[]
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

export function InboxItemDetail({ item: initialItem }: { item: InboxItemSerialized }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [item, setItem] = useState(initialItem)
  const [messages, setMessages] = useState<MessageItem[]>(initialItem.conversation?.messages ?? [])
  const [replyText, setReplyText] = useState(initialItem.draftReply ?? '')
  const [contextOpen, setContextOpen] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // ─── Polling каждые 10 сек, только при видимой вкладке ───
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null

    const refetch = async () => {
      const r = await fetchInboxItemFresh(item.id)
      if (!r.ok) return
      // Перенесли в setState без startTransition чтобы не блокировать UI ответа
      setItem((prev) => ({
        ...prev,
        status: r.data.item.status,
        clientMessage: r.data.item.clientMessage,
        // draftReply из БД подгружаем, но НЕ перетираем то что менеджер уже печатает
      }))
      setMessages(r.data.messages.map((m) => ({ ...m, createdAt: m.createdAt })))
    }

    const startPolling = () => {
      if (timer) return
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') {
          refetch()
        }
      }, POLL_INTERVAL_MS)
    }
    const stopPolling = () => {
      if (timer) { clearInterval(timer); timer = null }
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        refetch()
        startPolling()
      } else {
        stopPolling()
      }
    }

    if (document.visibilityState === 'visible') startPolling()
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      stopPolling()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  // Скролл к последнему сообщению при изменении
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length])

  function handleGenerate() {
    const hasUserText = replyText.trim() && replyText.trim() !== (item.draftReply ?? '').trim()
    if (hasUserText && !confirm('Заменить текущий текст в поле ответа на новый draft?')) {
      return
    }
    startTransition(async () => {
      const r = await ensureDraftReply(item.id, { force: true })
      if (r.ok) {
        setReplyText(r.data.draft)
        setItem((prev) => ({ ...prev, draftReply: r.data.draft }))
        toast.success('Draft готов')
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
    if (!item.client.maxChatId) {
      toast.error('У клиента не задан maxChatId')
      return
    }
    if (!confirm(`Отправить клиенту «${item.client.name}»?\n\n${text}`)) return
    startTransition(async () => {
      const r = await sendReplyAndResolve(item.id, text)
      if (r.ok) {
        toast.success('Отправлено')
        setReplyText('')
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  const maxLink = item.client.maxUsername ? `https://max.ru/${item.client.maxUsername}` : null

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
        <div className="ml-auto flex items-center gap-2">
          {item.client.contactPhone && (
            <a
              href={`tel:${item.client.contactPhone.replace(/\D/g, '')}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill border border-border-strong bg-surface text-fg text-xs font-medium hover:bg-bg transition-colors"
            >
              <Phone className="w-3.5 h-3.5" />
              {item.client.contactPhone}
            </a>
          )}
          {maxLink && (
            <a
              href={maxLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill bg-info-bg text-info-fg text-xs font-medium hover:opacity-90 transition-opacity"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Открыть в MAX
            </a>
          )}
        </div>
      </div>

      {item.humanReason && (
        <p className="text-sm text-fg-muted">{item.humanReason}</p>
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
        <div className="flex items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-fg-muted" />
            <h3 className="text-base font-semibold">Переписка</h3>
            <span className="text-xs text-fg-subtle">· последние 7 дней</span>
          </div>
        </div>

        {messages.length === 0 ? (
          <div className="rounded-xl bg-bg/40 p-3 text-sm">
            <p className="text-xs text-fg-muted mb-1">{formatDateShort(new Date(item.createdAt))}</p>
            <p>{item.clientMessage ?? '(нет текста)'}</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} clientName={item.client.name} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <h3 className="text-base font-semibold">Ответить</h3>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill border border-border-strong bg-surface text-fg text-xs font-medium hover:bg-bg transition-colors disabled:opacity-50"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {isPending ? 'Генерируем…' : item.draftReply ? 'Сгенерировать заново' : 'Сгенерировать draft'}
          </button>
        </div>

        <textarea
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          disabled={isPending}
          rows={4}
          placeholder="Введите ответ клиенту или нажмите «Сгенерировать draft»"
          className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-base md:text-sm resize-y"
        />

        {!item.client.maxChatId && (
          <p className="text-xs text-warning-fg mt-2">
            ⚠️ У клиента не задан maxChatId — отправка не сработает. Привяжите chat_id в карточке клиента.
          </p>
        )}

        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={handleSend}
            disabled={isPending || !replyText.trim() || !item.client.maxChatId}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-pill bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            Отправить
          </button>
        </div>
      </div>
    </div>
  )
}

function MessageBubble({
  message,
  clientName,
}: {
  message: MessageItem
  clientName: string
}) {
  const isClient = message.direction === 'IN'
  const isBot = message.direction === 'OUT'
  const author = isClient ? clientName : isBot ? 'Бот' : 'Менеджер'

  return (
    <div className={cn('flex flex-col', isClient ? 'items-start' : 'items-end')}>
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-3 py-2',
          isClient ? 'bg-bg/60' : isBot ? 'bg-info-bg/50' : 'bg-accent text-accent-fg'
        )}
      >
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
