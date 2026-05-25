'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db/prisma'
import { prismaDirect } from '@/lib/db/prisma-direct'
import { requireRole } from '@/lib/auth/current-user'
import { notifyGroup, escapeHtml } from '@/lib/telegram/notify'

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * Подтвердить приёмку накладной (ADMIN_PRO).
 *
 * - MATCHED_EXISTING + pricePerKgNormalized>0 → Ingredient.pricePerUnit = new, +history.
 * - CREATED_NEW → Ingredient.create({status:'DRAFT', brandVariants:[{rawName, ...}]}).
 *   Если name уже занят (race / Vision ошибся) — лечимся MATCHED_EXISTING-путём.
 * - Invoice.status=ACCEPTED, +acceptedBy/At.
 * - ActivityLog 'ADMIN_ACCEPT_INVOICE'.
 * - После транзакции — notifyInvoiceAlert (best-effort).
 */
export async function acceptInvoice(invoiceId: string): Promise<ActionResult> {
  const user = await requireRole(['ADMIN_PRO'])

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: true },
  })
  if (!invoice) return { ok: false, error: 'Накладная не найдена' }
  if (invoice.status !== 'AWAITING_ACCEPT') {
    return {
      ok: false,
      error: `Накладная в статусе ${invoice.status}, ожидался AWAITING_ACCEPT`,
    }
  }

  const now = new Date()

  try {
    await prismaDirect.$transaction(async (tx) => {
      for (const line of invoice.lines) {
        if (line.matchedAction === 'SKIPPED') continue

        if (line.matchedAction === 'MATCHED_EXISTING') {
          if (!line.matchedIngredientId) continue
          if (line.pricePerKgNormalized === null) continue
          const newPrice = Number(line.pricePerKgNormalized)
          if (newPrice <= 0) continue

          await tx.ingredient.update({
            where: { id: line.matchedIngredientId },
            data: { pricePerUnit: newPrice },
          })
          await tx.ingredientPriceHistory.create({
            data: {
              ingredientId: line.matchedIngredientId,
              price: newPrice,
              validFrom: now,
              changedBy: user.id,
            },
          })
        } else if (line.matchedAction === 'CREATED_NEW') {
          // Цена: нормализованная если есть, иначе сырая.
          const price =
            line.pricePerKgNormalized !== null
              ? Number(line.pricePerKgNormalized)
              : Number(line.rawPricePerUnit)

          // Race-safety: ингредиент с таким именем уже мог появиться.
          const existing = await tx.ingredient.findUnique({
            where: { name: line.rawName },
          })

          if (existing) {
            // Лечим как MATCHED_EXISTING к найденному ингредиенту.
            await tx.ingredient.update({
              where: { id: existing.id },
              data: { pricePerUnit: price },
            })
            await tx.ingredientPriceHistory.create({
              data: {
                ingredientId: existing.id,
                price,
                validFrom: now,
                changedBy: user.id,
              },
            })
            await tx.invoiceLine.update({
              where: { id: line.id },
              data: {
                matchedIngredientId: existing.id,
                matchedAction: 'MATCHED_EXISTING',
              },
            })
          } else {
            const created = await tx.ingredient.create({
              data: {
                name: line.rawName,
                unit: 'KG', // fallback — пользователь поправит при approveDraft
                pricePerUnit: price,
                status: 'DRAFT',
                brandVariants: [
                  {
                    rawName: line.rawName,
                    lastSeenPrice: Number(line.rawPricePerUnit),
                    lastSeenDate: now.toISOString(),
                  },
                ],
              },
            })
            await tx.ingredientPriceHistory.create({
              data: {
                ingredientId: created.id,
                price,
                validFrom: now,
                changedBy: user.id,
              },
            })
            await tx.invoiceLine.update({
              where: { id: line.id },
              data: { matchedIngredientId: created.id },
            })
          }
        }
      }

      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: 'ACCEPTED',
          acceptedById: user.id,
          acceptedAt: now,
        },
      })

      await tx.activityLog.create({
        data: {
          userId: user.id,
          userRole: user.role,
          action: 'ADMIN_ACCEPT_INVOICE',
          entityType: 'Invoice',
          entityId: invoiceId,
          payload: {
            supplierName: invoice.supplierName,
            invoiceNumber: invoice.invoiceNumber,
            totalAmount: invoice.totalAmount ? Number(invoice.totalAmount) : null,
            linesCount: invoice.lines.length,
          },
        },
      })
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Не удалось подтвердить приёмку: ${message}` }
  }

  // Best-effort алерт — не валим accept при сбое Telegram.
  try {
    const { notifyInvoiceAlert } = await import('@/lib/invoices/notify')
    await notifyInvoiceAlert(invoiceId)
  } catch (err) {
    try {
      const { trackError } = await import('@/lib/errors/tracker')
      await trackError({
        error: err as Error,
        extra: { invoiceId, source: 'acceptInvoice.notify' },
      })
    } catch {}
  }

  revalidatePath('/invoices')
  revalidatePath(`/invoices/${invoiceId}`)
  return { ok: true, data: undefined }
}

/**
 * Отклонить приёмку. Цены не трогаем, только меняем статус + reason.
 */
export async function rejectInvoice(
  invoiceId: string,
  reason: string
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN_PRO'])

  const trimmedReason = reason.trim()
  if (!trimmedReason) return { ok: false, error: 'Укажите причину отклонения' }
  if (trimmedReason.length > 500) {
    return { ok: false, error: 'Причина слишком длинная (макс. 500)' }
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { status: true, supplierName: true, invoiceNumber: true },
  })
  if (!invoice) return { ok: false, error: 'Накладная не найдена' }
  if (invoice.status !== 'AWAITING_ACCEPT') {
    return {
      ok: false,
      error: `Накладная в статусе ${invoice.status}, ожидался AWAITING_ACCEPT`,
    }
  }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: 'REJECTED', aiErrorMessage: trimmedReason },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'ADMIN_REJECT_INVOICE',
      entityType: 'Invoice',
      entityId: invoiceId,
      payload: {
        supplierName: invoice.supplierName,
        invoiceNumber: invoice.invoiceNumber,
        reason: trimmedReason,
      },
    },
  })

  revalidatePath('/invoices')
  revalidatePath(`/invoices/${invoiceId}`)
  return { ok: true, data: undefined }
}

/**
 * Откатить приёмку: цены вернуть на предыдущие, DRAFT-ингредиенты деактивировать.
 *
 * Для MATCHED_EXISTING: предыдущая IngredientPriceHistory (validFrom < acceptedAt).
 *   Если есть — pricePerUnit=previous + новый history (для аудита revert).
 *   Если нет — pricePerUnit=0 (placeholder), history(price=0).
 * Для CREATED_NEW: Ingredient.isActive=false (мягкое удаление).
 */
export async function revertInvoice(invoiceId: string): Promise<ActionResult> {
  const user = await requireRole(['ADMIN_PRO'])

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: true },
  })
  if (!invoice) return { ok: false, error: 'Накладная не найдена' }
  if (invoice.status !== 'ACCEPTED') {
    return {
      ok: false,
      error: `Откатить можно только ACCEPTED, сейчас ${invoice.status}`,
    }
  }
  if (!invoice.acceptedAt) {
    return { ok: false, error: 'У накладной нет acceptedAt — неконсистентное состояние' }
  }

  const now = new Date()
  const acceptedAt = invoice.acceptedAt

  try {
    await prismaDirect.$transaction(async (tx) => {
      for (const line of invoice.lines) {
        if (!line.matchedIngredientId) continue

        if (line.matchedAction === 'MATCHED_EXISTING') {
          // Предыдущая цена до приёмки.
          const prevHistory = await tx.ingredientPriceHistory.findFirst({
            where: {
              ingredientId: line.matchedIngredientId,
              validFrom: { lt: acceptedAt },
            },
            orderBy: { validFrom: 'desc' },
          })

          const restorePrice = prevHistory ? Number(prevHistory.price) : 0

          await tx.ingredient.update({
            where: { id: line.matchedIngredientId },
            data: { pricePerUnit: restorePrice },
          })
          await tx.ingredientPriceHistory.create({
            data: {
              ingredientId: line.matchedIngredientId,
              price: restorePrice,
              validFrom: now,
              changedBy: user.id,
            },
          })
        } else if (line.matchedAction === 'CREATED_NEW') {
          // Мягкое удаление созданного при accept ингредиента.
          await tx.ingredient.update({
            where: { id: line.matchedIngredientId },
            data: { isActive: false },
          })
        }
      }

      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: 'REVERTED',
          revertedById: user.id,
          revertedAt: now,
        },
      })

      await tx.activityLog.create({
        data: {
          userId: user.id,
          userRole: user.role,
          action: 'ADMIN_REVERT_INVOICE',
          entityType: 'Invoice',
          entityId: invoiceId,
          payload: {
            supplierName: invoice.supplierName,
            invoiceNumber: invoice.invoiceNumber,
            linesCount: invoice.lines.length,
          },
        },
      })
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Не удалось откатить приёмку: ${message}` }
  }

  // Best-effort пуш в общий чат.
  try {
    const msg =
      `↩️ <b>Откат приёмки от ${escapeHtml(invoice.supplierName)}</b>\n` +
      `Номер: ${escapeHtml(invoice.invoiceNumber)}\n` +
      `Выполнил: ${escapeHtml(user.name)}`
    await notifyGroup(msg, { parseMode: 'HTML' })
  } catch (err) {
    try {
      const { trackError } = await import('@/lib/errors/tracker')
      await trackError({
        error: err as Error,
        extra: { invoiceId, source: 'revertInvoice.notify' },
      })
    } catch {}
  }

  revalidatePath('/invoices')
  revalidatePath(`/invoices/${invoiceId}`)
  return { ok: true, data: undefined }
}

/**
 * Подтвердить DRAFT-ингредиент (созданный из накладной): status DRAFT → APPROVED.
 */
export async function approveDraftIngredient(
  ingredientId: string
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN_PRO'])

  const ing = await prisma.ingredient.findUnique({
    where: { id: ingredientId },
    select: { id: true, name: true, status: true },
  })
  if (!ing) return { ok: false, error: 'Ингредиент не найден' }
  if (ing.status === 'APPROVED') {
    return { ok: false, error: 'Ингредиент уже APPROVED' }
  }

  await prisma.ingredient.update({
    where: { id: ingredientId },
    data: { status: 'APPROVED' },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'ADMIN_APPROVE_DRAFT_INGREDIENT',
      entityType: 'Ingredient',
      entityId: ingredientId,
      payload: { name: ing.name },
    },
  })

  revalidatePath('/ingredients')
  return { ok: true, data: undefined }
}
