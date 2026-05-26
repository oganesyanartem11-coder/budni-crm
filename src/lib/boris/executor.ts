/**
 * Executor для Боря-pending-actions (Спринт 7.16.A.2, блок B2).
 *
 * После того как пользователь нажимает inline-кнопку «Подтверждаю»,
 * обвязка (telegram/bot.ts в B3) вызывает executePendingAction(id, userId).
 *
 * Что делаем:
 * - Загружаем BorisPendingAction
 * - Проверяем что записан тем же userId (через conversation)
 * - Проверяем что не executed/cancelled/expired
 * - Идём по actions[] и для каждого зовём соответствующий server action
 *   из @/app/(app)/orders/actions
 * - Помечаем executedAt после прохода
 *
 * Tolerance: один tool падает — остальные продолжают. Это лучше чем
 * атомарный rollback, потому что server actions не транзакционны
 * (они каждый делает свои revalidatePath/notifyGroup), и мы не хотим
 * валить весь batch из-за одной ошибки.
 *
 * Server actions используются с `as never` каст потому, что они принимают
 * z.infer<их Zod-схема>; JSON в БД теряет precise тип, но валидация всё
 * равно произойдёт внутри самого action (safeParse).
 *
 * NB: restoreOrder/addOrderNote/createOneTimeOrder/rescheduleOrder будут
 * добавлены параллельно в блоке B1. На момент когда B2 пишется они могут
 * не существовать — TS поймает это при финальном tsc, и B1 импортирует
 * их к моменту мерджа.
 */

import { prisma } from '@/lib/db/prisma'
import {
  editOrderPortions,
  cancelOrder,
  restoreOrder,
  rescheduleOrder,
  addOrderNote,
  createOneTimeOrder,
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

  const actions = pending.actions as Array<{
    tool: string
    input: Record<string, unknown>
  }>
  const results: ExecuteResultItem[] = []

  for (const a of actions) {
    try {
      let r: { ok: boolean; error?: string; data?: unknown }
      switch (a.tool) {
        case 'edit_order_portions':
          r = await editOrderPortions(a.input as never)
          break
        case 'cancel_order':
          r = await cancelOrder(a.input as never)
          break
        case 'restore_order':
          r = await restoreOrder(a.input as never)
          break
        case 'reschedule_order':
          r = await rescheduleOrder(a.input as never)
          break
        case 'add_order_note':
          r = await addOrderNote(a.input as never)
          break
        case 'create_one_time_order':
          r = await createOneTimeOrder(a.input as never)
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
    } catch (e) {
      results.push({
        tool: a.tool,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  await prisma.borisPendingAction.update({
    where: { id: pendingActionId },
    data: { executedAt: new Date() },
  })

  return { ok: results.every((r) => r.ok), results }
}
