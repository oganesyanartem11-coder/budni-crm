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
  /**
   * [{ locationId, portions, mealType? }] из ParsedResponse.items. mealType —
   * если клиент назвал приём пищи («обед 75, завтрак и ужин 45»).
   */
  items: Array<{ locationId: string; portions: number; mealType?: MealType; mode?: 'add' }>
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
  /** Строки, которым не нашлось питания (точка без такого приёма пищи). */
  unmatchedItems: Array<{ locationId: string; mealType?: MealType; portions: number; reason: string }>
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

  // Приёмы пищи, названные клиентом явно, по точке: строка без mealType
  // («30») не должна перетирать их числом.
  const namedMeals = new Map<string, Set<MealType>>()
  for (const item of input.items) {
    if (!item.mealType) continue
    const set = namedMeals.get(item.locationId) ?? new Set<MealType>()
    set.add(item.mealType)
    namedMeals.set(item.locationId, set)
  }
  const handled = new Set<string>()
  const unmatchedItems: SaveBotOrdersResult['unmatchedItems'] = []

  for (const item of input.items) {
    const locationConfigs = input.activeMealConfigsByLocation[item.locationId] ?? []
    // Баг 06.10 («Идеология Еды»): «Обед 75, завтрак и ужин 45» — каждое число
    // применялось ко ВСЕМ приёмам точки, последнее перетирало обед (75 → 45),
    // а клиенту уходило 6 строк «Повадино — …». Теперь строка с mealType —
    // только свой приём; без mealType — все приёмы, не названные явно.
    const configs = item.mealType
      ? locationConfigs.filter((c) => c.mealType === item.mealType)
      : locationConfigs.filter((c) => !namedMeals.get(item.locationId)?.has(c.mealType))
    const unmatched = (reason: string) =>
      unmatchedItems.push({
        locationId: item.locationId,
        ...(item.mealType ? { mealType: item.mealType } : {}),
        portions: item.portions,
        reason,
      })
    if (item.mealType && configs.length === 0) {
      unmatched('у точки нет такого приёма пищи')
      continue
    }
    // «Добавьте 2» без приёма пищи при нескольких приёмах — непонятно, к чему.
    if (item.mode === 'add' && configs.length > 1) {
      unmatched('непонятно, к какому приёму пищи прибавить')
      continue
    }
    for (const cfg of configs) {
      const key = `${item.locationId}:${cfg.mealType}`
      if (handled.has(key)) continue
      handled.add(key)
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

      // «Добавьте 2» / «на 3 меньше»: итог = что стоит в заказе + изменение.
      // Заказа нет или он ещё без ответа (0 в PENDING) — прибавлять не к чему.
      let portions = item.portions
      if (item.mode === 'add') {
        const hasBase =
          existing && !(existing.portions === 0 && (existing.status === 'PENDING_CONFIRMATION' || existing.status === 'DRAFT'))
        if (!existing || !hasBase) {
          unmatched('заказа на этот день ещё нет — не к чему прибавить')
          continue
        }
        portions = existing.portions + item.portions
        if (portions < 0) {
          unmatched(`в заказе ${existing.portions}, убрать ${-item.portions} нельзя`)
          continue
        }
      }

      if (existing) {
        const needsPortionsUpdate = existing.portions !== portions
        // GUARD: разрешён ТОЛЬКО переход PENDING_CONFIRMATION → CONFIRMED.
        // Любой другой статус (CONFIRMED/LOCKED/IN_PRODUCTION/OUT_FOR_DELIVERY/
        // DELIVERED) НИКОГДА не понижается и не трогается здесь.
        const needsStatusBump = existing.status === 'PENDING_CONFIRMATION'

        if (needsPortionsUpdate || needsStatusBump) {
          await prisma.order.update({
            where: { id: existing.id },
            data: {
              portions: portions,
              totalPrice: cfg.pricePerPortion * portions,
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
            portions: portions,
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
            portions: portions,
            pricePerPortion: cfg.pricePerPortion,
            totalPrice: cfg.pricePerPortion * portions,
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
          portions: portions,
          wasUpdate: false,
        })
      }
    }
  }

  return { savedItems, wasUpdate, unmatchedItems }
}
