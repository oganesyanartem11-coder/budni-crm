/**
 * Executor для Боря-pending-actions.
 *
 * После того как пользователь нажимает inline-кнопку «Подтверждаю»,
 * обвязка (telegram/bot.ts) вызывает executePendingAction(id, userId).
 *
 * Что делаем:
 * - Загружаем BorisPendingAction
 * - Проверяем что записан тем же userId (через conversation)
 * - Проверяем что не executed/cancelled/expired
 * - Подгружаем User из БД (id + role) и вызываем *Core-функции
 *   из @/app/(app)/orders/actions с явным user аргументом.
 *   ⚠️ Боря вызывает Core, а НЕ server action wrapper —
 *   wrapper вызывает requireRole, который читает cookies; в TG webhook
 *   контексте cookies нет, redirect('/login') бросит NEXT_REDIRECT.
 * - Помечаем executedAt после прохода
 *
 * Tolerance: один tool падает — остальные продолжают. Server actions не
 * транзакционны между собой (revalidatePath/notifyGroup), и атомарный
 * rollback всё равно невозможен — лучше частичный успех с прозрачным отчётом.
 */

import { prisma } from '@/lib/db/prisma'
import { BorisMetricSource } from '@prisma/client'
import { trackBorisCall } from './metrics/track'
import {
  editOrderPortionsCore,
  cancelOrderCore,
  restoreOrderCore,
  rescheduleOrderCore,
  addOrderNoteCore,
  createOneTimeOrderCore,
} from '@/app/(app)/orders/actions'

export interface ExecuteResultItem {
  tool: string
  ok: boolean
  error?: string
  data?: unknown
}

export interface ExecuteResult {
  ok: boolean
  results: ExecuteResultItem[]
}

export async function executePendingAction(
  pendingActionId: string,
  userId: string,
): Promise<ExecuteResult> {
  const pending = await prisma.borisPendingAction.findUnique({
    where: { id: pendingActionId },
    include: { conversation: true },
  })

  if (!pending) {
    return { ok: false, results: [{ tool: '_', ok: false, error: 'pending_action_not_found' }] }
  }
  if (pending.conversation.userId !== userId) {
    return { ok: false, results: [{ tool: '_', ok: false, error: 'wrong_user' }] }
  }
  if (pending.executedAt || pending.cancelledAt) {
    return { ok: false, results: [{ tool: '_', ok: false, error: 'already_processed' }] }
  }
  if (pending.expiresAt < new Date()) {
    return { ok: false, results: [{ tool: '_', ok: false, error: 'expired' }] }
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  })
  if (!user) {
    return { ok: false, results: [{ tool: '_', ok: false, error: 'user_not_found' }] }
  }

  const actions = pending.actions as Array<{
    tool: string
    input: Record<string, unknown>
  }>
  const results: ExecuteResultItem[] = []

  for (const a of actions) {
    const startedAt = Date.now()
    try {
      let r: { ok: boolean; error?: string; data?: unknown }
      switch (a.tool) {
        case 'edit_order_portions':
          r = await editOrderPortionsCore(user, a.input)
          break
        case 'cancel_order':
          r = await cancelOrderCore(user, a.input)
          break
        case 'restore_order':
          r = await restoreOrderCore(user, a.input)
          break
        case 'reschedule_order':
          r = await rescheduleOrderCore(user, a.input)
          break
        case 'add_order_note':
          r = await addOrderNoteCore(user, a.input)
          break
        case 'create_one_time_order':
          r = await createOneTimeOrderCore(user, a.input)
          break
        default:
          r = { ok: false, error: `unknown_tool:${a.tool}` }
      }
      results.push({
        tool: a.tool,
        ok: r.ok,
        error: !r.ok ? r.error : undefined,
        data: 'data' in r ? r.data : undefined,
      })
      // Метрика по итерации (executor не делает LLM-вызовов, токены = 0).
      await trackBorisCall({
        userId,
        conversationId: pending.conversationId,
        toolName: a.tool,
        ok: r.ok,
        errorMessage: !r.ok ? r.error : undefined,
        durationMs: Date.now() - startedAt,
        source: BorisMetricSource.ACTION_EXECUTOR,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      results.push({
        tool: a.tool,
        ok: false,
        error: errMsg,
      })
      await trackBorisCall({
        userId,
        conversationId: pending.conversationId,
        toolName: a.tool,
        ok: false,
        errorMessage: errMsg,
        durationMs: Date.now() - startedAt,
        source: BorisMetricSource.ACTION_EXECUTOR,
      })
    }
  }

  await prisma.borisPendingAction.update({
    where: { id: pendingActionId },
    data: { executedAt: new Date() },
  })

  return { ok: results.every((r) => r.ok), results }
}
