import { prisma } from '@/lib/db/prisma'
import { getOrderLegalEntitySnapshot } from '@/lib/orders/legal-entity-snapshot'
import type { MealType } from '@prisma/client'

export interface SavedItem {
  locationId: string
  locationName: string
  mealType: MealType
  portions: number
  wasUpdate: boolean
  /** Порции ДО обновления. Заполняется только в update-ветке (wasUpdate=true). */
  previousPortions?: number
}

export interface SaveBotOrdersInput {
  clientId: string
  conversationId: string
  deliveryDate: Date
  /** [{ locationId, portions }] из ParsedResponse.items */
  items: Array<{ locationId: string; portions: number }>
  /** Активные meal-конфиги, сгруппированные по locationId */
  activeMealConfigsByLocation: Record<
    string,
    Array<{ mealType: MealType; pricePerPortion: number; locationName: string }>
  >
  /** Сырой текст клиента — попадает в InboxItem.clientMessage при escalation. */
  clientMessage?: string
}

export interface SaveBotOrdersResult {
  savedItems: SavedItem[]
  wasUpdate: boolean
}

/**
 * Сохраняет заказы по результатам LLM-парсинга.
 * Идемпотентность: бизнес-ключ = (clientId, locationId, mealType, deliveryDate).
 * Если заказ уже есть и portions совпадают — пропуск.
 * Если portions отличаются — UPDATE.
 *
 * 6.8a: orphan-config safety net удалён — после миграции
 * drop_maxchatid_and_lock_locationid поле ClientMealConfig.locationId
 * NOT NULL, поэтому конфиги без локации больше невозможны.
 */
export async function saveBotOrders(input: SaveBotOrdersInput): Promise<SaveBotOrdersResult> {
  const savedItems: SavedItem[] = []
  let wasUpdate = false

  // Snapshot юрлица/НДС берём один раз — он одинаков для всех заказов клиента.
  const snapshot = await getOrderLegalEntitySnapshot(input.clientId)

  for (const item of input.items) {
    const configs = input.activeMealConfigsByLocation[item.locationId] ?? []
    for (const cfg of configs) {
      const existing = await prisma.order.findFirst({
        where: {
          clientId: input.clientId,
          locationId: item.locationId,
          mealType: cfg.mealType,
          deliveryDate: input.deliveryDate,
          status: { notIn: ['CANCELLED'] },
        },
        select: { id: true, portions: true, status: true },
      })

      if (existing) {
        const needsPortionsUpdate = existing.portions !== item.portions
        // GUARD: разрешён ТОЛЬКО переход PENDING_CONFIRMATION → CONFIRMED.
        // Любой другой статус (CONFIRMED/LOCKED/IN_PRODUCTION/OUT_FOR_DELIVERY/
        // DELIVERED) НИКОГДА не понижается и не трогается здесь.
        const needsStatusBump = existing.status === 'PENDING_CONFIRMATION'

        if (needsPortionsUpdate || needsStatusBump) {
          await prisma.order.update({
            where: { id: existing.id },
            data: {
              portions: item.portions,
              totalPrice: cfg.pricePerPortion * item.portions,
              sourceConversationId: input.conversationId,
              // status выставляем ТОЛЬКО при подтверждении из PENDING_CONFIRMATION.
              ...(needsStatusBump ? { status: 'CONFIRMED' as const, confirmedAt: new Date() } : {}),
            },
          })
          wasUpdate = true
          savedItems.push({
            locationId: item.locationId,
            locationName: cfg.locationName,
            mealType: cfg.mealType,
            portions: item.portions,
            wasUpdate: true,
            previousPortions: existing.portions,
          })
        }
      } else {
        // Нужна локация для дефолтных packaging/tags
        const loc = await prisma.clientLocation.findUnique({
          where: { id: item.locationId },
          select: { packaging: true, tags: true },
        })
        if (!loc) continue

        await prisma.order.create({
          data: {
            clientId: input.clientId,
            locationId: item.locationId,
            mealType: cfg.mealType,
            deliveryDate: input.deliveryDate,
            portions: item.portions,
            pricePerPortion: cfg.pricePerPortion,
            totalPrice: cfg.pricePerPortion * item.portions,
            status: 'CONFIRMED',
            source: 'BOT',
            sourceConversationId: input.conversationId,
            packaging: loc.packaging,
            tags: loc.tags,
            confirmedAt: new Date(),
            ourLegalEntityId: snapshot.ourLegalEntityId,
            vatRate: snapshot.vatRate,
          },
        })
        savedItems.push({
          locationId: item.locationId,
          locationName: cfg.locationName,
          mealType: cfg.mealType,
          portions: item.portions,
          wasUpdate: false,
        })
      }
    }
  }

  return { savedItems, wasUpdate }
}
