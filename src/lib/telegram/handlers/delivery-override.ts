import type { Context } from 'grammy'
import type { DeliveryOverrideStatus } from '@prisma/client'
import { resolveDeliveryOverrideRequestCore } from '@/lib/delivery/delivery-override'
import { registerCallbackHandler } from '../callback-router'
import { requireTelegramUser } from '../identify-user'
import { prisma } from '@/lib/db/prisma'

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

/**
 * «ХАЛВА · Офис, курьер Иван» — чтобы после правки было видно, о какой
 * доставке речь (исходное сообщение с этими данными затирается).
 */
async function loadOverrideContext(requestId: string): Promise<string | null> {
  try {
    const request = await prisma.deliveryOverrideRequest.findUnique({
      where: { id: requestId },
      select: {
        courierNameSnapshot: true,
        resolvedByNameSnapshot: true,
        stop: { select: { clientNameSnapshot: true, locationNameSnapshot: true } },
      },
    })
    if (!request) return null
    const by = request.resolvedByNameSnapshot ? ` Решение: ${request.resolvedByNameSnapshot}.` : ''
    return (
      `${request.stop.clientNameSnapshot} · ${request.stop.locationNameSnapshot}, ` +
      `курьер ${request.courierNameSnapshot}.${by}`
    )
  } catch (error) {
    console.error('[delivery-override] load context failed', error)
    return null
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
  // Спиннер снимаем сразу после решения, правка — следом.
  try {
    await ctx.answerCallbackQuery({
      text: result.idempotent ? 'Уже обработано' : 'Готово',
    })
  } catch (error) {
    console.error('[delivery-override] answerCallbackQuery failed', error)
  }
  const about = await loadOverrideContext(requestId)
  await safeEdit(ctx, about ? `${resolvedMessage(result.status)}\n${about}` : resolvedMessage(result.status))
}

registerCallbackHandler({
  scope: 'dovr',
  handle: handleDeliveryOverrideCallback,
})
