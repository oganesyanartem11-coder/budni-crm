import type { Context } from 'grammy'
import type { DeliveryOverrideStatus } from '@prisma/client'
import { resolveDeliveryOverrideRequestCore } from '@/lib/delivery/delivery-override'
import { registerCallbackHandler } from '../callback-router'
import { requireTelegramUser } from '../identify-user'

const MANAGER_ROLES = ['ADMIN_PRO', 'ADMIN', 'MANAGER'] as const

function resolvedMessage(status: DeliveryOverrideStatus): string {
  if (status === 'APPROVED') return '✅ Доставка подтверждена менеджером.'
  if (status === 'REJECTED') return '❌ Запрос отклонён менеджером.'
  if (status === 'PENDING') return '⏳ Запрос всё ещё ждёт решения менеджера.'
  return '⌛ Срок запроса истёк. Курьеру нужно отправить новый запрос.'
}

async function safeEdit(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.editMessageText(text)
  } catch (error) {
    console.error('[delivery-override] editMessageText failed', error)
  }
}

export async function handleDeliveryOverrideCallback(
  ctx: Context,
  action: string,
  requestId: string,
): Promise<void> {
  if (action !== 'approve' && action !== 'reject') {
    await ctx.answerCallbackQuery({ text: 'Неизвестное действие' })
    return
  }

  const actor = await requireTelegramUser(ctx, [...MANAGER_ROLES])
  if (!actor) return

  const result = await resolveDeliveryOverrideRequestCore(actor, {
    requestId,
    decision: action === 'approve' ? 'APPROVE' : 'REJECT',
    comment: null,
    now: new Date(),
  })
  await safeEdit(ctx, resolvedMessage(result.status))
  await ctx.answerCallbackQuery({
    text: result.idempotent ? 'Уже обработано' : 'Готово',
  })
}

registerCallbackHandler({
  scope: 'dovr',
  handle: handleDeliveryOverrideCallback,
})
