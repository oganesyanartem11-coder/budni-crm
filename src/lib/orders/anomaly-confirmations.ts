import type { MealType, Prisma, UserRole } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { createOneTimeOrderCore } from '@/app/(app)/orders/actions'
import { createInboxItem } from '@/lib/bot/create-inbox-item'

export interface PendingAnomalyKey {
  clientId: string
  locationId: string
  mealType: MealType
  deliveryDate: Date
  proposedPortions: number
  conversationId?: string | null
}

/**
 * Идемпотентность повторной доставки MAX: пока точное подтверждение остаётся
 * PENDING, повторно используем его вместо создания второго.
 */
export async function createOrReusePendingAnomalyConfirmation(input: PendingAnomalyKey) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const { conversationId, ...confirmationKey } = input
          const existing = await tx.pendingAnomalyConfirmation.findFirst({
            where: { ...confirmationKey, status: 'PENDING' },
            orderBy: { createdAt: 'desc' },
          })

          if (existing) {
            if (existing.conversationId === null && conversationId) {
              const attached = await tx.pendingAnomalyConfirmation.updateMany({
                where: { id: existing.id, status: 'PENDING', conversationId: null },
                data: { conversationId },
              })

              if (attached.count === 1) {
                return {
                  confirmation: { ...existing, conversationId },
                  reused: true as const,
                }
              }

              const current = await tx.pendingAnomalyConfirmation.findUnique({
                where: { id: existing.id },
              })
              if (current) return { confirmation: current, reused: true as const }
            }

            return { confirmation: existing, reused: true as const }
          }

          const confirmation = await tx.pendingAnomalyConfirmation.create({
            data: input,
          })
          return { confirmation, reused: false as const }
        },
        { isolationLevel: 'Serializable' },
      )
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : null
      if (code !== 'P2034' || attempt === 3) throw error
    }
  }

  throw new Error('Не удалось создать подтверждение аномалии')
}

export interface EnsurePendingAnomalyInboxInput {
  confirmationId: string
  clientId: string
  conversationId?: string | null
  humanReason: string
  clientMessage?: string | null
  parsedJson?: Prisma.InputJsonValue
  clientStatsSnapshot?: Prisma.InputJsonValue
}

/**
 * InboxItem не имеет FK на pending confirmation, поэтому используем стабильный
 * marker в реальном humanReason и дедуплицируем только открытые записи.
 */
export async function ensurePendingAnomalyInbox(input: EnsurePendingAnomalyInboxInput) {
  const marker = `[anom:${input.confirmationId}]`
  const existing = await prisma.inboxItem.findFirst({
    where: {
      clientId: input.clientId,
      reason: 'ANOMALY_HISTORICAL',
      resolvedAt: null,
      humanReason: { contains: marker },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (existing) return existing

  return createInboxItem({
    clientId: input.clientId,
    conversationId: input.conversationId,
    reason: 'ANOMALY_HISTORICAL',
    humanReason: `${marker} ${input.humanReason}`,
    priority: 'NORMAL',
    clientMessage: input.clientMessage,
    parsedJson: input.parsedJson,
    clientStatsSnapshot: input.clientStatsSnapshot,
  })
}

export type ConfirmPendingAnomalyResult =
  | { ok: true; orderId: string; portions: number; recovered?: true }
  | {
      ok: false
      reason:
        | 'already_processed'
        | 'already_processing'
        | 'not_found'
        | 'core_error'
        | 'baseline_error'
      error?: string
      orderId?: string
    }

const PROCESSING_STALE_AFTER_MS = 2 * 60 * 1000

interface AnomalyOrderKey {
  clientId: string
  locationId: string
  mealType: MealType
  deliveryDate: Date
}

async function findExistingOrderForAnomaly(confirmation: AnomalyOrderKey) {
  return prisma.order.findFirst({
    where: {
      clientId: confirmation.clientId,
      locationId: confirmation.locationId,
      mealType: confirmation.mealType,
      deliveryDate: confirmation.deliveryDate,
      status: { not: 'CANCELLED' },
    },
    select: { id: true },
  })
}

async function releaseAnomalyProcessing(
  confirmationId: string,
  processingAt: Date,
  clearResolution = true,
) {
  return prisma.pendingAnomalyConfirmation.updateMany({
    where: { id: confirmationId, status: 'PROCESSING', processingAt },
    data: clearResolution
      ? {
          status: 'PENDING',
          processingAt: null,
          resolvedAt: null,
          resolvedById: null,
        }
      : { status: 'PENDING', processingAt: null },
  })
}

async function finalizeAnomalyConfirmation(input: {
  confirmation: {
    id: string
    clientId: string
    locationId: string
    conversationId: string | null
    proposedPortions: number
  }
  userId: string
  orderId: string
  recovered?: true
}): Promise<ConfirmPendingAnomalyResult> {
  let baselineError: string | null = null

  try {
    await prisma.clientPortionBaseline.upsert({
      where: {
        clientId_locationId: {
          clientId: input.confirmation.clientId,
          locationId: input.confirmation.locationId,
        },
      },
      create: {
        clientId: input.confirmation.clientId,
        locationId: input.confirmation.locationId,
        portions: input.confirmation.proposedPortions,
        updatedById: input.userId,
      },
      update: {
        portions: input.confirmation.proposedPortions,
        updatedById: input.userId,
      },
    })
  } catch (error) {
    baselineError = error instanceof Error ? error.message : 'Неизвестная ошибка baseline'
    console.error('[anomaly-confirmation] baseline upsert failed', error)
  }

  const resolvedAt = new Date()
  await prisma.$transaction(async (tx) => {
    const finalized = await tx.pendingAnomalyConfirmation.updateMany({
      where: { id: input.confirmation.id, status: 'PROCESSING' },
      data: {
        status: 'CONFIRMED',
        processingAt: null,
        resolvedAt,
        resolvedById: input.userId,
      },
    })

    if (finalized.count !== 1) {
      throw new Error('Не удалось завершить подтверждение аномалии')
    }

    if (input.confirmation.conversationId) {
      await tx.botConversation.updateMany({
        where: {
          id: input.confirmation.conversationId,
          clientId: input.confirmation.clientId,
        },
        data: { status: 'CONFIRMED' },
      })
    }
  })

  if (baselineError) {
    return {
      ok: false,
      reason: 'baseline_error',
      error: baselineError,
      orderId: input.orderId,
    }
  }

  return {
    ok: true,
    orderId: input.orderId,
    portions: input.confirmation.proposedPortions,
    ...(input.recovered ? { recovered: true as const } : {}),
  }
}

function terminalResult(status: string): ConfirmPendingAnomalyResult | null {
  if (status === 'PROCESSING') return { ok: false, reason: 'already_processing' }
  if (status !== 'PENDING') return { ok: false, reason: 'already_processed' }
  return null
}

/**
 * Сначала выполняется условный PENDING→PROCESSING claim. CONFIRMED ставится
 * только после физического Order; stale PROCESSING восстанавливается по точному
 * бизнес-ключу заказа.
 */
export async function confirmPendingAnomaly(input: {
  confirmationId: string
  user: { id: string; role: UserRole }
}): Promise<ConfirmPendingAnomalyResult> {
  let confirmation = await prisma.pendingAnomalyConfirmation.findUnique({
    where: { id: input.confirmationId },
    include: {
      client: { select: { id: true, name: true } },
      location: { select: { id: true, name: true } },
    },
  })

  if (!confirmation) return { ok: false, reason: 'not_found' }

  if (confirmation.status === 'PROCESSING') {
    const processingAt = confirmation.processingAt
    const isFresh =
      processingAt !== null && Date.now() - processingAt.getTime() < PROCESSING_STALE_AFTER_MS
    if (isFresh) return { ok: false, reason: 'already_processing' }

    const existingOrder = await findExistingOrderForAnomaly(confirmation)
    if (existingOrder) {
      return finalizeAnomalyConfirmation({
        confirmation,
        userId: input.user.id,
        orderId: existingOrder.id,
        recovered: true,
      })
    }

    if (processingAt) {
      const released = await releaseAnomalyProcessing(confirmation.id, processingAt, false)
      if (released.count !== 1) {
        const current = await prisma.pendingAnomalyConfirmation.findUnique({
          where: { id: input.confirmationId },
        })
        if (!current) return { ok: false, reason: 'not_found' }
        return terminalResult(current.status) ?? { ok: false, reason: 'already_processed' }
      }
    } else {
      const released = await prisma.pendingAnomalyConfirmation.updateMany({
        where: { id: confirmation.id, status: 'PROCESSING', processingAt: null },
        data: { status: 'PENDING' },
      })
      if (released.count !== 1) return { ok: false, reason: 'already_processing' }
    }

    confirmation = { ...confirmation, status: 'PENDING', processingAt: null }
  } else {
    const terminal = terminalResult(confirmation.status)
    if (terminal) return terminal
  }

  const processingAt = new Date()
  const claim = await prisma.pendingAnomalyConfirmation.updateMany({
    where: { id: input.confirmationId, status: 'PENDING' },
    data: {
      status: 'PROCESSING',
      processingAt,
    },
  })

  if (claim.count === 0) {
    const current = await prisma.pendingAnomalyConfirmation.findUnique({
      where: { id: input.confirmationId },
    })
    if (!current) return { ok: false, reason: 'not_found' }
    return terminalResult(current.status) ?? { ok: false, reason: 'already_processed' }
  }

  let orderResult: Awaited<ReturnType<typeof createOneTimeOrderCore>>
  try {
    orderResult = await createOneTimeOrderCore(input.user, {
      clientId: confirmation.clientId,
      locationId: confirmation.locationId,
      mealType: confirmation.mealType,
      deliveryDate: confirmation.deliveryDate,
      portions: confirmation.proposedPortions,
      source: 'CLIENT_REQUEST',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка создания заказа'
    const existingOrder = await findExistingOrderForAnomaly(confirmation)
    if (existingOrder) {
      return finalizeAnomalyConfirmation({
        confirmation,
        userId: input.user.id,
        orderId: existingOrder.id,
        recovered: true,
      })
    }

    await releaseAnomalyProcessing(input.confirmationId, processingAt)
    return { ok: false, reason: 'core_error', error: message }
  }

  if (!orderResult.ok) {
    await releaseAnomalyProcessing(input.confirmationId, processingAt)
    return { ok: false, reason: 'core_error', error: orderResult.error }
  }

  return finalizeAnomalyConfirmation({
    confirmation,
    userId: input.user.id,
    orderId: orderResult.data.orderId,
  })
}

export type RejectPendingAnomalyResult =
  | { ok: true; inboxItemId: string }
  | { ok: false; reason: 'already_processed' | 'not_found' }

export async function rejectPendingAnomaly(input: {
  confirmationId: string
  userId: string
}): Promise<RejectPendingAnomalyResult> {
  const claim = await prisma.pendingAnomalyConfirmation.updateMany({
    where: { id: input.confirmationId, status: 'PENDING' },
    data: {
      status: 'REJECTED',
      resolvedAt: new Date(),
      resolvedById: input.userId,
    },
  })

  if (claim.count === 0) return { ok: false, reason: 'already_processed' }

  const confirmation = await prisma.pendingAnomalyConfirmation.findUnique({
    where: { id: input.confirmationId },
    include: {
      client: { select: { id: true, name: true } },
      location: { select: { id: true, name: true } },
    },
  })
  if (!confirmation) return { ok: false, reason: 'not_found' }

  const inbox = await ensurePendingAnomalyInbox({
    confirmationId: confirmation.id,
    clientId: confirmation.clientId,
    conversationId: confirmation.conversationId,
    humanReason:
      `Аномальное количество ${confirmation.proposedPortions} порций отклонено менеджером ` +
      `для точки «${confirmation.location.name}».`,
  })

  return { ok: true, inboxItemId: inbox.id }
}
