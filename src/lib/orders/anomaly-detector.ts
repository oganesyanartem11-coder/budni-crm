import { LLM_CONFIDENCE_THRESHOLD } from './anomaly-constants'
import type { ParsedResponse } from '@/lib/llm/parser'
import type { ClientStats } from './client-stats'
import type { InboxItemReason, InboxItemPriority, OrderStatus, PrismaClient } from '@prisma/client'

export interface AnomalyResult {
  isAnomaly: boolean
  reason: InboxItemReason | null
  humanReason: string
  priority: InboxItemPriority
}

export interface DetectInput {
  parsed: ParsedResponse
  stats: ClientStats
  isNewClient: boolean
  isPastCutoff: boolean
}

/**
 * Не-числовые/контекстные аномалии: cutoff, тон, отмена, неуверенность LLM,
 * новый клиент. ВАЖНО: проверка «цифра вне нормы» по порциям ВЫНЕСЕНА в
 * detectPortionAnomaly (динамический порог 50–200% от истории по дню недели,
 * MEGA-4a). Старые глобальные пороги MIN=10/MAX=200 и SUSPICIOUS_ROUND_NUMBERS
 * удалены — из-за них 8 порций для «СК Техник» ложно помечались «вне нормы».
 */
export function detectAnomalies(input: DetectInput): AnomalyResult {
  const { parsed, isNewClient, isPastCutoff } = input

  // 1. Post-cutoff — всегда в inbox
  if (isPastCutoff) {
    return {
      isAnomaly: true,
      reason: 'POST_CUTOFF',
      humanReason: 'Сообщение пришло после 16:00',
      priority: 'NORMAL',
    }
  }

  // 2. Грубый тон — высокий приоритет
  if (parsed.toneLabel === 'rude') {
    return {
      isAnomaly: true,
      reason: 'NON_NUMERIC',
      humanReason: 'Клиент написал в грубом тоне',
      priority: 'HIGH',
    }
  }

  // 3. Не-цифровые ответы
  if (parsed.type === 'cancellation_intent') {
    return {
      isAnomaly: true,
      reason: 'CANCELLATION_INTENT',
      humanReason: `Клиент сообщает об отмене: ${parsed.reason}`,
      priority: 'NORMAL',
    }
  }
  if (parsed.type === 'question' || parsed.type === 'noise') {
    return {
      isAnomaly: true,
      reason: 'NON_NUMERIC',
      humanReason: parsed.reason || 'Не цифровой ответ',
      priority: 'NORMAL',
    }
  }

  // 4. LLM не уверен
  if (parsed.confidence < LLM_CONFIDENCE_THRESHOLD) {
    return {
      isAnomaly: true,
      reason: 'ANOMALY_LLM_CONFIDENCE',
      humanReason: `LLM не уверен в парсинге (${(parsed.confidence * 100).toFixed(0)}%): ${parsed.reason}`,
      priority: 'NORMAL',
    }
  }

  // 5. Новый клиент — всегда в inbox
  if (isNewClient) {
    return {
      isAnomaly: true,
      reason: 'NEW_CLIENT',
      humanReason: 'Новый клиент (ещё нет 5 безопасных ответов подряд)',
      priority: 'NORMAL',
    }
  }

  return {
    isAnomaly: false,
    reason: null,
    humanReason: '',
    priority: 'NORMAL',
  }
}

// ─────────────────────────────────────────────────────────────────────
// MEGA-4a (П10): динамический детектор «цифра вне нормы» по порциям.
// Глобальный порог 10 заменён на 50–200% от среднего конкретного клиента
// по конкретному дню недели (МСК) за последние 90 дней.
// ─────────────────────────────────────────────────────────────────────

const PORTION_ANOMALY_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
]

/** Минимум прошлых заказов в выборке, ниже которого не алёртим (cold-start). */
const MIN_SAMPLES = 3
const LOWER_FACTOR = 0.5
const UPPER_FACTOR = 2.0
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000

export interface AnomalyContext {
  clientId: string
  locationId: string | null
  deliveryDate: Date
  proposedPortions: number
}

export interface AnomalyResultPortion {
  isAnomaly: boolean
  reason: 'no_history' | 'below_threshold' | 'above_threshold' | null
  expected?: { min: number; max: number; average: number; samples: number }
}

/**
 * День недели в МСК (0=Вс..6=Сб, формат JS getUTCDay) для @db.Date или любого
 * Date. deliveryDate хранится как UTC-полночь календарной даты; прибавление +3ч
 * и чтение UTC-компонент = «календарный день в МСК» (для Москвы DST не действует
 * с 2011, +3 константа — тот же приём, что в msk-window.ts).
 */
function mskDayOfWeek(date: Date): number {
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).getUTCDay()
}

/**
 * Детектор «цифра вне нормы»: сравнивает предложенное число порций со средним
 * этого клиента (и локации, если задана) по тому же дню недели за 90 дней.
 *
 * - samples < 3 → no_history, НЕ аномалия (cold-start bypass).
 * - proposed < average*0.5 → below_threshold.
 * - proposed > average*2.0 → above_threshold (строгое сравнение: ровно 2× — ОК).
 */
export async function detectPortionAnomaly(
  ctx: AnomalyContext,
  prisma: PrismaClient
): Promise<AnomalyResultPortion> {
  const targetDow = mskDayOfWeek(ctx.deliveryDate)
  const ninetyDaysAgo = new Date(ctx.deliveryDate.getTime() - NINETY_DAYS_MS)

  const orders = await prisma.order.findMany({
    where: {
      clientId: ctx.clientId,
      ...(ctx.locationId !== null ? { locationId: ctx.locationId } : {}),
      status: { in: PORTION_ANOMALY_STATUSES },
      // Только прошлые заказы, не включая сам deliveryDate.
      deliveryDate: { gte: ninetyDaysAgo, lt: ctx.deliveryDate },
    },
    select: { portions: true, deliveryDate: true },
  })

  const sameDow = orders.filter((o) => mskDayOfWeek(o.deliveryDate) === targetDow)
  const samples = sameDow.length

  if (samples < MIN_SAMPLES) {
    return { isAnomaly: false, reason: 'no_history' }
  }

  const average = sameDow.reduce((sum, o) => sum + o.portions, 0) / samples
  const min = Math.round(average * LOWER_FACTOR)
  const max = Math.round(average * UPPER_FACTOR)
  const expected = { min, max, average: Math.round(average), samples }

  if (ctx.proposedPortions < average * LOWER_FACTOR) {
    return { isAnomaly: true, reason: 'below_threshold', expected }
  }
  if (ctx.proposedPortions > average * UPPER_FACTOR) {
    return { isAnomaly: true, reason: 'above_threshold', expected }
  }

  return { isAnomaly: false, reason: null, expected }
}
