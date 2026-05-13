'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Sparkles, Send, AlertTriangle, MessageSquare,
  User2, ExternalLink, Phone, History, CheckCircle2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  ensureDraftReply, sendReplyAndResolve, fetchClientThreadFresh,
} from '../actions'
import { formatTime, formatDateShort } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import type {
  BotMessageDirection, InboxItemReason, InboxItemPriority,
  InboxItemStatus,
} from '@prisma/client'

const POLL_INTERVAL_MS = 10_000

const REASON_LABELS: Record<InboxItemReason, string> = {
  NEW_CLIENT: 'Новый клиент',
  ANOMALY_HISTORICAL: 'Изменение от обычного',
  ANOMALY_THRESHOLD: 'Подозрительное число',
  ANOMALY_LLM_CONFIDENCE: 'LLM не уверен',
  NON_NUMERIC: 'Не цифра',
  CANCELLATION_INTENT: 'Отмена',
  POST_CUTOFF: 'После cut-off',
}

interface MessageItem {
  id: string
  direction: BotMessageDirection
  text: string
  createdAt: Date | string
  toneLabel: string | null
}

interface ClientLight {
  id: string
  name: string
  contactPhone: string | null
  maxChatId: string | null
  maxUsername: string | null
}

interface ActiveItem {
  id: string
  status: InboxItemStatus
  reason: InboxItemReason
  priority: InboxItemPriority
  humanReason: string | null
  clientMessage: string | null
  draftReply: string | null
  parsedJson: unknown
  clientStatsSnapshot: unknown
  createdAt: Date | string
  conversationId: string | null
}

interface HistoryItem {
  id: string
  status: InboxItemStatus
  reason: InboxItemReason
  priority: InboxItemPriority
  humanReason: string | null
  clientMessage: string | null
  managerReply: string | null
  createdAt: Date | string
  resolvedAt: Date | string | null
  resolvedBy: { id: string; name: string } | null
}

interface Props {
  client: ClientLight
  activeItem: ActiveItem | null
  history: HistoryItem[]
  messages: MessageItem[]
}

export function ClientInboxView({ client, activeItem: initialActive, history, messages: initialMessages }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [activeItem, setActiveItem] = useState(initialActive)
  const [messages, setMessages] = useState<MessageItem[]>(initialMessages)
  const [replyText, setReplyText] = useState(initialActive?.draftReply ?? '')
  const [contextOpen, setContextOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesBoxRef = useRef<HTMLDivElement>(null)

  // Polling. При обновлении НЕ дёргаем scroll: если пользователь скроллил
  // вверх, чтобы посмотреть старое сообщение — оставляем его позицию.
  // Прыжок к низу только когда пользователь уже у низа (sticky-to-bottom).
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null

    const refetch = async () => {
      const r = await fetchClientThreadFresh(client.id)
      if (!r.ok) return
      const box = messagesBoxRef.current
      const wasAtBottom = box
        ? box.scrollHeight - box.scrollTop - box.clientHeight < 80
        : true

      setActiveItem((prev) => {
        if (!r.data.activeItem) return prev
        return prev
          ? { ...prev, id: r.data.activeItem.id, status: r.data.activeItem.status, clientMessage: r.data.activeItem.clientMessage }
          : null
      })
      setMessages(r.data.messages)

      if (wasAtBottom) {
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ block: 'end' })
        })
      }
    }

    const startPolling = () => {
      if (timer) return
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') refetch()
      }, POLL_INTERVAL_MS)
    }
    const stopPolling = () => {
      if (timer) { clearInterval(timer); timer = null }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refetch()
        startPolling()
      } else {
        stopPolling()
      }
    }

    if (document.visibilityState === 'visible') startPolling()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopPolling()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id])

  // Первичная прокрутка к низу при монтировании.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [])

  function handleGenerate() {
    if (!activeItem) {
      toast.error('Нет активного обращения')
      return
    }
    const hasUserText = replyText.trim() && replyText.trim() !== (activeItem.draftReply ?? '').trim()
    if (hasUserText && !confirm('Заменить текущий текст в поле ответа на новый draft?')) {
      return
    }
    startTransition(async () => {
      const r = await ensureDraftReply(activeItem.id, { force: true })
      if (r.ok) {
        setReplyText(r.data.draft)
        setActiveItem((prev) => prev ? { ...prev, draftReply: r.data.draft } : prev)
        toast.success('Draft готов')
      } else {
        toast.error(r.error)
      }
    })
  }

  function handleSend() {
    if (!activeItem) {
      toast.error('Нет активного обращения')
      return
    }
    const text = replyText.trim()
    if (!text) {
      toast.error('Текст ответа пуст')
      return
    }
    if (!client.maxChatId) {
      toast.error('У клиента не задан maxChatId')
      return
    }
    if (!confirm(`Отправить клиенту «${client.name}»?\n\n${text}`)) return
    startTransition(async () => {
      const r = await sendReplyAndResolve(activeItem.id, text)
      if (r.ok) {
        toast.success('Отправлено')
        setReplyText('')
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  const maxLink = client.maxUsername ? `https://max.ru/${client.maxUsername}` : null
  const hasContext = activeItem && (!!activeItem.clientStatsSnapshot || !!activeItem.parsedJson)
  const olderHistory = activeItem ? history.filter((h) => h.id !== activeItem.id) : history

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        {activeItem ? (
          <>
            <span className="inline-flex items-center px-2.5 py-1 rounded-pill bg-neutral-bg text-neutral-fg text-xs font-medium">
              {REASON_LABELS[activeItem.reason]}
            </span>
            {activeItem.priority === 'HIGH' && (
              <span className="inline-flex items-center px-2.5 py-1 rounded-pill bg-danger-bg text-danger-fg text-xs font-semibold">
                HIGH
              </span>
            )}
            {activeItem.status === 'READ' && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-pill bg-success-bg text-success-fg text-xs font-medium">
                <CheckCircle2 className="w-3 h-3" />
                Прочитано
              </span>
            )}
          </>
        ) : (
          <span className="inline-flex items-center px-2.5 py-1 rounded-pill bg-neutral-bg text-neutral-fg text-xs font-medium">
            Активных обращений нет
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {client.contactPhone && (
            <a
              href={`tel:${client.contactPhone.replace(/\D/g, '')}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill border border-border-strong bg-surface text-fg text-xs font-medium hover:bg-bg transition-colors"
            >
              <Phone className="w-3.5 h-3.5" />
              {client.contactPhone}
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

      {activeItem?.humanReason && (
        <p className="text-sm text-fg-muted">{activeItem.humanReason}</p>
      )}

      {hasContext && (
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
          {contextOpen && activeItem && (
            <div className="px-4 py-3 border-t border-border space-y-3 text-sm">
              {activeItem.clientStatsSnapshot ? (
                <div>
                  <p className="text-xs uppercase tracking-wider text-fg-muted mb-1">Статистика клиента</p>
                  <pre className="text-xs bg-bg/40 rounded-xl p-3 overflow-x-auto">
                    {JSON.stringify(activeItem.clientStatsSnapshot, null, 2)}
                  </pre>
                </div>
              ) : null}
              {activeItem.parsedJson ? (
                <div>
                  <p className="text-xs uppercase tracking-wider text-fg-muted mb-1">Разбор LLM</p>
                  <pre className="text-xs bg-bg/40 rounded-xl p-3 overflow-x-auto">
                    {JSON.stringify(activeItem.parsedJson, null, 2)}
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
            <p className="text-xs text-fg-muted mb-1">
              {activeItem ? formatDateShort(new Date(activeItem.createdAt)) : '—'}
            </p>
            <p>{activeItem?.clientMessage ?? '(нет текста)'}</p>
          </div>
        ) : (
          <div ref={messagesBoxRef} className="space-y-2 max-h-[60vh] overflow-y-auto">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} clientName={client.name} />
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
            disabled={isPending || !activeItem}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill border border-border-strong bg-surface text-fg text-xs font-medium hover:bg-bg transition-colors disabled:opacity-50"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {isPending ? 'Генерируем…' : activeItem?.draftReply ? 'Сгенерировать заново' : 'Сгенерировать draft'}
          </button>
        </div>

        <textarea
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          disabled={isPending || !activeItem}
          rows={4}
          placeholder={activeItem ? 'Введите ответ клиенту или нажмите «Сгенерировать draft»' : 'Нет активного обращения для ответа'}
          className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-base md:text-sm resize-y"
        />

        {!client.maxChatId && (
          <p className="text-xs text-warning-fg mt-2">
            ⚠️ У клиента не задан maxChatId — отправка не сработает. Привяжите chat_id в карточке клиента.
          </p>
        )}

        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={handleSend}
            disabled={isPending || !replyText.trim() || !client.maxChatId || !activeItem}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-pill bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            Отправить
          </button>
        </div>
      </div>

      {olderHistory.length > 0 && (
        <div className="rounded-2xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className="w-full px-4 py-3 flex items-center justify-between hover:bg-bg/30 transition-colors"
          >
            <span className="text-sm font-medium flex items-center gap-2">
              <History className="w-4 h-4 text-fg-muted" />
              История обращений · {olderHistory.length}
            </span>
            <span className="text-xs text-fg-muted">{historyOpen ? '▲' : '▼'}</span>
          </button>
          {historyOpen && (
            <ul className="divide-y divide-border">
              {olderHistory.map((h) => (
                <li key={h.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-pill bg-neutral-bg text-neutral-fg text-[11px] font-medium">
                        {REASON_LABELS[h.reason]}
                      </span>
                      {h.priority === 'HIGH' && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-pill bg-danger-bg text-danger-fg text-[11px] font-semibold">
                          HIGH
                        </span>
                      )}
                      {h.status === 'READ' ? (
                        <span className="inline-flex items-center gap-1 text-xs text-success-fg">
                          <CheckCircle2 className="w-3 h-3" />
                          Закрыто
                          {h.resolvedBy && <span className="text-fg-subtle">· {h.resolvedBy.name}</span>}
                        </span>
                      ) : (
                        <span className="text-xs text-warning-fg">Открыто</span>
                      )}
                    </div>
                    <span className="text-xs text-fg-subtle">
                      {formatDateShort(new Date(h.createdAt))} · {formatTime(new Date(h.createdAt))}
                    </span>
                  </div>
                  {h.clientMessage && (
                    <p className="text-sm text-fg-muted line-clamp-2">«{h.clientMessage}»</p>
                  )}
                  {h.managerReply && (
                    <p className="text-xs text-fg-subtle mt-1">Ответ: {h.managerReply}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
