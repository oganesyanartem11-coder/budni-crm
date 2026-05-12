import { prisma } from '@/lib/db/prisma'
import { createInboxItem } from './create-inbox-item'
import { notifyManagersAboutInboxItem } from './notify-managers'
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
  /** Сырой текст клиента — попадает в InboxItem.clientMessage при escalation. */
  clientMessage?: string
}

export interface SaveBotOrdersResult {
  savedItems: SavedItem[]
  wasUpdate: boolean
  /**
   * true если найдены orphan-конфиги (locationId=null) у клиента с 2+ адресами:
   * Order'ы НЕ создаём, заводим InboxItem HIGH + пушим менеджеру. Вызывающий
   * (process-message) должен ответить клиенту нейтрально и перевести conv
   * в AWAITING_MANAGER.
   */
  escalated?: boolean
  escalatedInboxItemId?: string
}

/**
 * Сохраняет заказы по результатам LLM-парсинга.
 * Идемпотентность: бизнес-ключ = (clientId, locationId, mealType, deliveryDate).
 * Если заказ уже есть и portions совпадают — пропуск.
 * Если portions отличаются — UPDATE.
 *
 * 5.9b: рантайм-страховка от orphan-конфигов (ClientMealConfig.locationId = null).
 * UI 5.9b делает locationId обязательным при создании, но старые записи в БД
 * могут существовать. Поведение:
 *   - orphan + 0 локаций  → лог error, продолжаем (Order создать невозможно)
 *   - orphan + 1 локация  → авто-привязка orphan-конфигов к этой локации
 *     (обогащаем activeMealConfigsByLocation для текущей пачки)
 *   - orphan + 2+ локаций → НЕ создаём Order, InboxItem HIGH + push менеджеру
 */
export async function saveBotOrders(input: SaveBotOrdersInput): Promise<SaveBotOrdersResult> {
  // ─── Orphan-конфиг safety net (см. JSDoc выше) ──────────────────────────
  const orphanConfigs = await prisma.clientMealConfig.findMany({
    where: { clientId: input.clientId, isActive: true, locationId: null },
    select: { id: true, mealType: true, pricePerPortion: true },
  })

  if (orphanConfigs.length > 0) {
    const activeLocations = await prisma.clientLocation.findMany({
      where: { clientId: input.clientId, isActive: true },
      select: { id: true, name: true },
    })

    if (activeLocations.length === 0) {
      console.error('[saveBotOrders] orphan configs found but client has no active locations', {
        clientId: input.clientId,
        orphanConfigIds: orphanConfigs.map((c) => c.id),
      })
      // Items-loop ниже всё равно ничего не создаст, валится естественным образом.
    } else if (activeLocations.length === 1) {
      const loc = activeLocations[0]
      const existing = input.activeMealConfigsByLocation[loc.id] ?? []
      input.activeMealConfigsByLocation[loc.id] = [
        ...existing,
        ...orphanConfigs.map((oc) => ({
          mealType: oc.mealType,
          pricePerPortion: Number(oc.pricePerPortion),
          locationName: loc.name,
        })),
      ]
      console.log('[saveBotOrders] orphan-config fallback: attached to single location', {
        clientId: input.clientId,
        locationId: loc.id,
        orphanConfigIds: orphanConfigs.map((c) => c.id),
      })
    } else {
      const inbox = await createInboxItem({
        clientId: input.clientId,
        conversationId: input.conversationId,
        reason: 'NON_NUMERIC',
        humanReason:
          `Конфиг(и) без локации (${orphanConfigs.length} шт.), у клиента ${activeLocations.length} активных адресов. ` +
          `Не получается автоматически привязать заявку к адресу — выберите вручную в карточке клиента.`,
        priority: 'HIGH',
        clientMessage: input.clientMessage,
      })
      await notifyManagersAboutInboxItem(inbox.id).catch((e) => {
        console.error('[saveBotOrders] notifyManagers failed:', e)
      })
      console.warn('[saveBotOrders] orphan-config escalated', {
        clientId: input.clientId,
        inboxItemId: inbox.id,
        orphanConfigIds: orphanConfigs.map((c) => c.id),
        locationCount: activeLocations.length,
      })
      return {
        savedItems: [],
        wasUpdate: false,
        escalated: true,
        escalatedInboxItemId: inbox.id,
      }
    }
  }

  // ─── Основной цикл — без изменений ──────────────────────────────────────
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
