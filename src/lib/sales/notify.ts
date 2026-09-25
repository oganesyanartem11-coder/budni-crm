import { InlineKeyboard } from 'grammy'
import type { SalesTaskType } from '@prisma/client'
import { getTelegramEnv } from '@/lib/telegram/env'
import { escapeHtml, notifyAllAdminProDirect, notifyManagerDirect } from '@/lib/telegram/notify'
import { leadDisplayName, TASK_TYPE_RU } from './labels'
import { SALES_CALLBACK_SCOPE } from './callback-scope'

/**
 * Sprint 8.0 «Продажи»: TG-кнопки и пуши воронки (голос Бориса: коротко, тепло).
 * callback_data: `sales:<action>:<id>` (≤ 64 байта, см. callback-router).
 *
 * КОНТРАКТ: кнопки/callback-data финальные (их использует intake и хендлер
 * src/lib/telegram/handlers/sales.ts); ниже — пуш-напоминание notifyTaskDue
 * (cron /api/cron/sales-reminders).
 */

export { SALES_CALLBACK_SCOPE }

/** Быстрые «что дальше?» из TG: слот → задача (см. хендлер scope 'sales'). */
export const NEXT_STEP_SLOTS = ['call_t10', 'write_3d', 'kp_t10', 'none'] as const
export type NextStepSlot = (typeof NEXT_STEP_SLOTS)[number]

export function salesDoneData(taskId: string): string {
  return `${SALES_CALLBACK_SCOPE}:done:${taskId}`
}

export function salesSnoozeData(taskId: string): string {
  return `${SALES_CALLBACK_SCOPE}:snooze:${taskId}`
}

export function salesNextData(leadId: string, slot: NextStepSlot): string {
  return `${SALES_CALLBACK_SCOPE}:next:${leadId}:${slot}`
}

/** id действия 'next' = '<leadId>:<slot>' → части (split по последнему ':'). */
export function parseNextStepId(id: string): { leadId: string; slot: NextStepSlot } | null {
  const idx = id.lastIndexOf(':')
  if (idx <= 0) return null
  const leadId = id.slice(0, idx)
  const slot = id.slice(idx + 1)
  if (!(NEXT_STEP_SLOTS as readonly string[]).includes(slot)) return null
  return { leadId, slot: slot as NextStepSlot }
}

export function salesLeadUrl(leadId: string): string {
  return `${getTelegramEnv().appBaseUrl}/sales/${leadId}`
}

/** [Открыть заявку] + (если есть задача) [✅ Связался]. */
export function leadButtons(leadId: string, taskId?: string | null): InlineKeyboard {
  const kb = new InlineKeyboard().url('Открыть заявку', salesLeadUrl(leadId))
  if (taskId) kb.text('✅ Связался', salesDoneData(taskId))
  return kb
}

/** Клавиатура «Что дальше по …?» после выполненной задачи. */
export function nextStepKeyboard(leadId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Позвонить завтра 10:00', salesNextData(leadId, 'call_t10'))
    .row()
    .text('Написать через 3 дня', salesNextData(leadId, 'write_3d'))
    .row()
    .text('Отправить КП завтра', salesNextData(leadId, 'kp_t10'))
    .row()
    .text('Без шага', salesNextData(leadId, 'none'))
    .url('Открыть карточку', salesLeadUrl(leadId))
}

// ---------- Пуш-напоминание о задаче (cron sales-reminders) ----------

/** Под напоминанием: [✅ Сделано] [⏰ +1 день] / [Открыть]. */
export function taskDueKeyboard(taskId: string, leadId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Сделано', salesDoneData(taskId))
    .text('⏰ +1 день', salesSnoozeData(taskId))
    .row()
    .url('Открыть', salesLeadUrl(leadId))
}

export interface TaskDueTextTask {
  type: SalesTaskType
  title: string
  note: string | null
  dueAt: Date
}

export interface TaskDueTextLead {
  company: string | null
  name: string | null
  phone: string
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Строку «просрочено» показываем, только если опоздали больше чем на 30 мин. */
const OVERDUE_NOTICE_MS = 30 * MINUTE_MS
/** Авто-задача по новой заявке: её заголовок не дублируем строкой под типом. */
const AUTO_TASK_TITLE = 'Связаться'

/** «40 мин» / «3 ч» / «2 дн» — на сколько просрочено. */
function formatOverdue(ms: number): string {
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} мин`
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} ч`
  return `${Math.floor(ms / DAY_MS)} дн`
}

/**
 * Текст напоминания (HTML). Чистая функция: всё пользовательское — через escapeHtml.
 *   ⏰ Позвонить: <b>ООО Ромашка</b>
 *   📞 <code>+7 999 …</code>
 *   📌 Уточнить меню          ← только если title ≠ типу и ≠ «Связаться»
 *   📝 заметка                ← если есть
 *   ⚠️ просрочено на 2 ч      ← если опоздали > 30 мин
 */
export function buildTaskDueText(task: TaskDueTextTask, lead: TaskDueTextLead, now: Date): string {
  const typeLabel = TASK_TYPE_RU[task.type]
  const lines = [
    `⏰ ${escapeHtml(typeLabel)}: <b>${escapeHtml(leadDisplayName(lead))}</b>`,
    `📞 <code>${escapeHtml(lead.phone)}</code>`,
  ]
  const title = task.title.trim()
  if (title && title !== typeLabel && title !== AUTO_TASK_TITLE) {
    lines.push(`📌 ${escapeHtml(title)}`)
  }
  const note = task.note?.trim()
  if (note) lines.push(`📝 ${escapeHtml(note)}`)
  const overdueMs = now.getTime() - task.dueAt.getTime()
  if (overdueMs > OVERDUE_NOTICE_MS) {
    lines.push(`⚠️ просрочено на ${formatOverdue(overdueMs)}`)
  }
  return lines.join('\n')
}

export interface NotifyTaskDueTask extends TaskDueTextTask {
  id: string
  leadId: string
  assigneeId: string | null
}

export interface NotifyTaskDueLead extends TaskDueTextLead {
  id: string
}

export interface NotifyTaskDueResult {
  /** Хоть кому-то ушло. */
  delivered: boolean
  /** Никому не ушло, потому что некому (ни у кого нет telegramChatId). */
  skipped: boolean
  /** Ошибка Telegram API / исключение (при delivered=true — ошибка у исполнителя, ушло фолбэком). */
  error?: string
}

/**
 * Напоминание о задаче: исполнителю в личку; если исполнителя нет, у него нет
 * Telegram (skipped) или Telegram API отказал — всем ADMIN_PRO (чтобы
 * напоминание не потерялось). Не бросает.
 */
export async function notifyTaskDue(
  task: NotifyTaskDueTask,
  lead: NotifyTaskDueLead,
  now: Date = new Date()
): Promise<NotifyTaskDueResult> {
  try {
    const text = buildTaskDueText(task, lead, now)
    const replyMarkup = taskDueKeyboard(task.id, lead.id)

    let assigneeError: string | undefined
    if (task.assigneeId) {
      const direct = await notifyManagerDirect(task.assigneeId, text, { replyMarkup })
      if (direct.ok) return { delivered: true, skipped: false }
      if (!direct.skipped) assigneeError = `assignee: ${direct.error ?? 'telegram_error'}`
    }

    const all = await notifyAllAdminProDirect(text, { replyMarkup })
    if (all.sentTo > 0) {
      return assigneeError
        ? { delivered: true, skipped: false, error: assigneeError }
        : { delivered: true, skipped: false }
    }
    if (all.failed > 0 || assigneeError) {
      const parts = [assigneeError, all.failed > 0 ? `admin_pro_failed: ${all.failed}` : null]
      return { delivered: false, skipped: false, error: parts.filter(Boolean).join('; ') }
    }
    return { delivered: false, skipped: true }
  } catch (err) {
    return {
      delivered: false,
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
