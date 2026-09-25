import type { Context, InlineKeyboard } from 'grammy'
import type { LeadPipelineStatus, SalesTaskType } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { trackError } from '@/lib/errors/tracker'
import {
  changeLeadStatusCore,
  completeTaskCore,
  createTaskCore,
  rescheduleTaskCore,
} from '@/lib/sales/core'
import { isSalesRole, leadDisplayName, PIPELINE_STATUS_RU, TASK_TYPE_RU } from '@/lib/sales/labels'
import { leadButtons, nextStepKeyboard, parseNextStepId, type NextStepSlot } from '@/lib/sales/notify'
// Scope — из листового модуля: registerCallbackHandler ниже читает его при
// импорте, а sales/notify в цикле с telegram/bot (см. callback-scope.ts).
import { SALES_CALLBACK_SCOPE } from '@/lib/sales/callback-scope'
import { plusOneDay, quickSlots, type QuickSlots } from '@/lib/sales/time'
import type { SalesActor } from '@/lib/sales/types'
import { formatMskDateTimeShort } from '@/lib/utils/format'
import { registerCallbackHandler } from '../callback-router'
import { identifyTelegramUser } from '../identify-user'
import { escapeHtml } from '../notify'

/**
 * Sprint 8.0 «Продажи»: inline-кнопки воронки заявок, scope 'sales'.
 *
 *   sales:done:<taskId>          — ✅ Сделано / ✅ Связался (пуш-напоминание и чат заявок)
 *   sales:snooze:<taskId>        — ⏰ +1 день (пуш-напоминание)
 *   sales:next:<leadId>:<slot>   — «Что дальше?» после выполненной задачи
 *
 * Доступ — только SALES_ROLES (Core сам тоже проверяет роль). Ошибки не
 * всплывают в webhook: каждая ветка в try/catch → trackError + «Не получилось,
 * попробуй в CRM». Ошибки editMessage* («message is not modified», старое
 * сообщение) — не провал действия: оно уже выполнено в БД.
 *
 * Регистрация ПРИ ИМПОРТЕ модуля (side-effect) — модуль импортируется в bot.ts.
 */

const FAIL_TEXT = 'Не получилось, попробуй в CRM'
/** Telegram режет текст answerCallbackQuery на 200 символов. */
const ANSWER_MAX_LEN = 200
/** Предохранитель цикла «перенести на +1 день, пока не окажется в будущем». */
const MAX_SNOOZE_STEPS = 400

const NEXT_SLOT_TASK: Record<
  Exclude<NextStepSlot, 'none'>,
  { type: SalesTaskType; dueAt: (slots: QuickSlots) => Date }
> = {
  call_t10: { type: 'CALL', dueAt: (s) => s.tomorrow10 },
  write_3d: { type: 'WRITE', dueAt: (s) => s.in3days10 },
  kp_t10: { type: 'SEND_PROPOSAL', dueAt: (s) => s.tomorrow10 },
}

const HTML = { parse_mode: 'HTML' } as const

// ---------- Безопасные обёртки над Bot API ----------

async function answer(ctx: Context, text: string, showAlert = false): Promise<void> {
  try {
    await ctx.answerCallbackQuery({ text: text.slice(0, ANSWER_MAX_LEN), show_alert: showAlert })
  } catch (error) {
    // Callback уже отвечен / протух — не провал действия.
    console.error('[sales-callback] answerCallbackQuery failed', error)
  }
}

async function safeEditText(ctx: Context, html: string): Promise<void> {
  try {
    // Без reply_markup Telegram снимает клавиатуру — повторно нажать нельзя.
    await ctx.editMessageText(html, HTML)
  } catch (error) {
    console.error('[sales-callback] editMessageText failed', error)
  }
}

async function safeEditMarkup(ctx: Context, markup: InlineKeyboard): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: markup })
  } catch (error) {
    console.error('[sales-callback] editMessageReplyMarkup failed', error)
  }
}

async function safeReply(ctx: Context, html: string, markup?: InlineKeyboard): Promise<void> {
  try {
    await ctx.reply(html, markup ? { ...HTML, reply_markup: markup } : HTML)
  } catch (error) {
    console.error('[sales-callback] reply failed', error)
  }
}

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private'
}

// ---------- Действия ----------

async function handleDone(ctx: Context, actor: SalesActor, actorName: string, taskId: string): Promise<void> {
  const result = await completeTaskCore(actor, taskId)
  if (!result.ok) {
    await answer(ctx, result.error, true)
    return
  }
  const done = result.data
  if (done.alreadyDone) {
    await answer(ctx, 'Уже сделано')
    return
  }

  // Стадия «по смыслу задачи» (только вперёд по степперу) — применяем сразу, без вопроса.
  let appliedStatus: LeadPipelineStatus | null = null
  if (done.suggestedStatus) {
    try {
      const status = await changeLeadStatusCore(actor, { leadId: done.leadId, status: done.suggestedStatus })
      if (status.ok && status.data.changed) appliedStatus = status.data.status
      else if (!status.ok) console.warn(`[sales-callback] стадия не сдвинута lead=${done.leadId}: ${status.error}`)
    } catch (error) {
      // Задача уже закрыта — сбой стадии не делает всё действие проваленным.
      await trackError({
        error,
        level: 'warn',
        extra: { scope: SALES_CALLBACK_SCOPE, action: 'done', id: taskId, step: 'changeLeadStatus' },
      })
    }
  }

  const title = escapeHtml(done.task.title)
  const label = escapeHtml(done.leadLabel)
  const stageLine = appliedStatus ? `\nСтадия → ${escapeHtml(PIPELINE_STATUS_RU[appliedStatus])}` : ''

  if (isPrivateChat(ctx)) {
    // Личка: это пуш-напоминание — заменяем его итогом.
    await safeEditText(ctx, `✅ Сделано: ${title} — <b>${label}</b>${stageLine}`)
  } else {
    // Чат заявок: текст заявки не трогаем, снимаем только кнопку задачи.
    await safeEditMarkup(ctx, leadButtons(done.leadId))
    await safeReply(ctx, `✅ ${escapeHtml(actorName)}: ${title} — <b>${label}</b>${stageLine}`)
  }

  const moreTasks = done.hasOtherOpenTasks ? `\nВ плане ещё задач: ${done.otherOpenTasksCount}` : ''
  await safeReply(ctx, `Что дальше по <b>${label}</b>?${moreTasks}`, nextStepKeyboard(done.leadId))
  await answer(ctx, 'Готово')
}

async function handleSnooze(ctx: Context, actor: SalesActor, taskId: string, now: Date): Promise<void> {
  const task = await prisma.salesTask.findUnique({
    where: { id: taskId },
    select: { dueAt: true, doneAt: true, lead: { select: { company: true, name: true, phone: true } } },
  })
  if (!task) {
    await answer(ctx, 'Задача не найдена')
    return
  }
  if (task.doneAt) {
    await answer(ctx, 'Задача уже закрыта')
    return
  }
  const label = escapeHtml(leadDisplayName(task.lead))

  // Кнопка стоит под напоминанием о наступившем сроке. Срок уже в будущем —
  // значит, перенесли раньше (другой ADMIN_PRO со своей копией пуша / в CRM).
  if (task.dueAt.getTime() > now.getTime()) {
    await safeEditText(ctx, `⏰ Уже перенесено — <b>${label}</b>\n🗓 ${formatMskDateTimeShort(task.dueAt)}`)
    await answer(ctx, 'Уже перенесено')
    return
  }

  // +1 МСК-день с тем же временем; просроченную двигаем, пока срок не окажется
  // в будущем — иначе cron перешлёт напоминание через 10 минут.
  let newDue = plusOneDay(task.dueAt)
  for (let i = 0; newDue.getTime() <= now.getTime() && i < MAX_SNOOZE_STEPS; i++) {
    newDue = plusOneDay(newDue)
  }

  const result = await rescheduleTaskCore(actor, { taskId, dueAt: newDue })
  if (!result.ok) {
    await answer(ctx, result.error, true)
    return
  }
  await safeEditText(
    ctx,
    `⏰ Перенёс: ${escapeHtml(result.data.title)} — <b>${label}</b>\n🗓 ${formatMskDateTimeShort(result.data.dueAt)}`
  )
  await answer(ctx, 'Перенёс')
}

async function handleNext(ctx: Context, actor: SalesActor, id: string, now: Date): Promise<void> {
  const parsed = parseNextStepId(id)
  if (!parsed) {
    await answer(ctx, 'Неизвестное действие')
    return
  }
  const { leadId, slot } = parsed

  if (slot === 'none') {
    const openTasks = await prisma.salesTask.count({ where: { leadId, doneAt: null } })
    await safeEditText(
      ctx,
      openTasks > 0
        ? `Ок, новый шаг не ставлю — в плане ещё задач: ${openTasks}.`
        : 'Ок, без следующего шага. В CRM заявка помечена ⚠️'
    )
    await answer(ctx, 'Ок')
    return
  }

  const plan = NEXT_SLOT_TASK[slot]
  // createTaskCore идемпотентен: открытая задача лида того же типа с dueAt ±60 с
  // возвращается (deduplicated), дубль по двойному нажатию не создаётся.
  const result = await createTaskCore(actor, { leadId, type: plan.type, dueAt: plan.dueAt(quickSlots(now)) })
  if (!result.ok) {
    await answer(ctx, result.error, true)
    return
  }
  await safeEditText(
    ctx,
    `📌 Следующий шаг: ${escapeHtml(TASK_TYPE_RU[plan.type])} — ${formatMskDateTimeShort(result.data.dueAt)}`
  )
  await answer(ctx, result.data.deduplicated ? 'Уже в плане' : 'Записал')
}

// ---------- Точка входа ----------

export async function handleSalesCallback(
  ctx: Context,
  action: string,
  id: string,
  now: Date = new Date()
): Promise<void> {
  try {
    const user = await identifyTelegramUser(ctx)
    if (!user) {
      await answer(ctx, 'Не нашёл тебя', true)
      return
    }
    if (!isSalesRole(user.role)) {
      await answer(ctx, 'Нет доступа', true)
      return
    }
    const actor: SalesActor = { id: user.id, role: user.role }

    switch (action) {
      case 'done':
        await handleDone(ctx, actor, user.name, id)
        return
      case 'snooze':
        await handleSnooze(ctx, actor, id, now)
        return
      case 'next':
        await handleNext(ctx, actor, id, now)
        return
      default:
        await answer(ctx, 'Неизвестное действие')
    }
  } catch (error) {
    await trackError({ error, level: 'error', extra: { scope: SALES_CALLBACK_SCOPE, action, id } })
    await answer(ctx, FAIL_TEXT, true)
  }
}

registerCallbackHandler({
  scope: SALES_CALLBACK_SCOPE,
  handle: (ctx, action, id) => handleSalesCallback(ctx, action, id),
})
