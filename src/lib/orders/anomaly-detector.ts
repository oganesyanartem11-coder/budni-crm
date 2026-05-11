import {
  MIN_PORTIONS_THRESHOLD,
  MAX_PORTIONS_THRESHOLD,
  ANOMALY_DEVIATION_PCT,
  LLM_CONFIDENCE_THRESHOLD,
  SUSPICIOUS_ROUND_NUMBERS,
} from './anomaly-constants'
import type { ParsedResponse } from '@/lib/llm/parser'
import type { ClientStats } from './client-stats'
import type { InboxItemReason, InboxItemPriority } from '@prisma/client'

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

export function detectAnomalies(input: DetectInput): AnomalyResult {
  const { parsed, stats, isNewClient, isPastCutoff } = input

  // 1. Post-cutoff — всегда в inbox
  if (isPastCutoff) {
    return {
      isAnomaly: true,
      reason: 'POST_CUTOFF',
      humanReason: 'Сообщение пришло после 18:00',
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

  // 5. Threshold-аномалии по числам
  for (const item of parsed.items) {
    if (item.portions < MIN_PORTIONS_THRESHOLD) {
      return {
        isAnomaly: true,
        reason: 'ANOMALY_THRESHOLD',
        humanReason: `Слишком мало порций: ${item.portions} (минимум ${MIN_PORTIONS_THRESHOLD})`,
        priority: 'NORMAL',
      }
    }
    if (item.portions > MAX_PORTIONS_THRESHOLD) {
      return {
        isAnomaly: true,
        reason: 'ANOMALY_THRESHOLD',
        humanReason: `Слишком много порций: ${item.portions} (максимум ${MAX_PORTIONS_THRESHOLD})`,
        priority: 'NORMAL',
      }
    }
    if (SUSPICIOUS_ROUND_NUMBERS.has(item.portions)) {
      return {
        isAnomaly: true,
        reason: 'ANOMALY_THRESHOLD',
        humanReason: `Подозрительно ровное число: ${item.portions}`,
        priority: 'NORMAL',
      }
    }
  }

  // 6. Историческое отклонение
  if (stats.averageByDayOfWeek !== null && stats.sampleSize >= 3) {
    const avg = stats.averageByDayOfWeek
    for (const item of parsed.items) {
      const deviation = Math.abs(item.portions - avg) / avg
      if (deviation > ANOMALY_DEVIATION_PCT) {
        const pct = Math.round(deviation * 100)
        return {
          isAnomaly: true,
          reason: 'ANOMALY_HISTORICAL',
          humanReason: `Отклонение ${pct}% от средней (${avg} порций по этому дню недели), клиент ответил ${item.portions}`,
          priority: 'NORMAL',
        }
      }
    }
  }

  // 7. Новый клиент — всегда в inbox
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
