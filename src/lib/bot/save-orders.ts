import { prisma } from '@/lib/db/prisma'
import type { MealType } from '@prisma/client'

export interface SavedItem {
  locationId: string
  locationName: string
  mealType: MealType
  portions: number
  wasUpdate: boolean
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
}

/**
 * Сохраняет заказы по результатам LLM-парсинга.
 * Идемпотентность: бизнес-ключ = (clientId, locationId, mealType, deliveryDate).
 * Если заказ уже есть и portions совпадают — пропуск.
 * Если portions отличаются — UPDATE.
 *
 * Source = BOT, sourceConversationId привязан к BotConversation.
 */
export async function saveBotOrders(input: SaveBotOrdersInput): Promise<{
  savedItems: SavedItem[]
  wasUpdate: boolean
}> {
  const savedItems: SavedItem[] = []
  let wasUpdate = false

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
        select: { id: true, portions: true },
      })

      if (existing) {
        if (existing.portions !== item.portions) {
          await prisma.order.update({
            where: { id: existing.id },
            data: {
              portions: item.portions,
              totalPrice: cfg.pricePerPortion * item.portions,
              sourceConversationId: input.conversationId,
            },
          })
          wasUpdate = true
          savedItems.push({
            locationId: item.locationId,
            locationName: cfg.locationName,
            mealType: cfg.mealType,
            portions: item.portions,
            wasUpdate: true,
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
