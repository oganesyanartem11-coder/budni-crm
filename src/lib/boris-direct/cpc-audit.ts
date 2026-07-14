/**
 * Детектор ФАКТИЧЕСКОГО CPC (контур №0, спринт 14.07). ЧИСТЫЕ функции.
 *
 * Аудит 14.07: списания за клик доходили до 831 ₽ (12.07) и 1276 ₽ (03.07) при
 * НАЗНАЧАЕМОМ потолке ставки 400 ₽. Потолок (write-gate) ограничивает НАЗНАЧАЕМУЮ
 * ставку, но не СПИСЫВАЕМУЮ цену: алгоритмическая надбавка/множители пробивают его.
 * Никто этого не сверял (дыра «данные есть — мысли нет»). Детектор считает CPC =
 * расход/клики построчно и флагует превышение потолка с запасом на НДС и округление.
 *
 * ТОЛЬКО алерт/сводка. Ставки НЕ трогает (это наблюдение, а не действие). Живёт в
 * РОУТЕ → полигон-нейтрально. Конверсии тут не нужны — считаем только деньги/клики.
 */

import type { Anomaly } from './anomalies'
import { BID_CEILING_MICRO, MICRO, CPC_OVER_CEILING_VAT, CPC_OVER_CEILING_MARGIN } from './config'

/** Номинальный потолок НАЗНАЧАЕМОЙ ставки, ₽ (нетто, без НДС). */
const CEILING_RUB = BID_CEILING_MICRO / MICRO

/** Потолок, приведённый к НДС-brutто (как списываемая цена в отчёте): 400 × 1.2 = 480 ₽.
 *  Именно с ним сравниваем расход при расчёте «лишних» денег (cost из отчёта — с НДС). */
const CEILING_GROSS_RUB = CEILING_RUB * CPC_OVER_CEILING_VAT

/** Порог «клик выше потолка»: 400 ₽ × НДС × запас на округление ≈ 528 ₽. */
export function cpcCeilingRub(): number {
  return CEILING_RUB * CPC_OVER_CEILING_VAT * CPC_OVER_CEILING_MARGIN
}

export interface CpcRow {
  /** Текст фразы/запроса (ключ ошибки). */
  key: string
  clicks: number
  costRub: number
  /** МСК-день строки (для текста алерта). */
  date: string
}

export interface CpcOverRow {
  key: string
  cpcRub: number
  clicks: number
  costRub: number
  date: string
}

export interface CpcAuditResult {
  /** Строки с CPC выше порога, по убыванию CPC. */
  over: CpcOverRow[]
  overCount: number
  /** Списано СВЕРХ номинального потолка 400 ₽ по всем нарушителям, ₽. */
  extraRub: number
  alert: Anomaly | null
}

/** Сколько нарушителей показываем в тексте алерта (топ по CPC). */
const TOP_IN_ALERT = 5

/** Флаг строк с фактическим CPC (расход/клики) выше «дырявого» потолка. */
export function auditCpc(rows: CpcRow[]): CpcAuditResult {
  const threshold = cpcCeilingRub()
  const over: CpcOverRow[] = []
  for (const r of rows) {
    if (r.clicks <= 0 || r.costRub <= 0) continue
    const cpc = r.costRub / r.clicks
    if (cpc > threshold) {
      over.push({
        key: r.key,
        cpcRub: Math.round(cpc * 100) / 100,
        clicks: r.clicks,
        costRub: Math.round(r.costRub * 100) / 100,
        date: r.date,
      })
    }
  }
  over.sort((a, b) => b.cpcRub - a.cpcRub)

  // «Лишнее» — списанное сверх потолка С НДС (480 ₽/клик): расход в отчёте тоже с
  // НДС, поэтому сравниваем gross-с-gross (иначе завышали бы на НДС от потолка).
  const extraRub =
    Math.round(over.reduce((acc, o) => acc + Math.max(0, o.costRub - o.clicks * CEILING_GROSS_RUB), 0) * 100) / 100

  let alert: Anomaly | null = null
  if (over.length > 0) {
    const top = over
      .slice(0, TOP_IN_ALERT)
      .map((o) => `«${o.key}» ${Math.round(o.cpcRub)} ₽/клик (${o.date})`)
      .join('; ')
    alert = {
      severity: 'critical',
      kind: 'cpc_over_ceiling',
      text:
        `[ПОТОЛОК] кликов дороже назначаемого потолка ${Math.round(CEILING_RUB)} ₽ (порог с НДС ${Math.round(threshold)} ₽): ` +
        `${over.length} шт., списано сверх потолка с НДС (${Math.round(CEILING_GROSS_RUB)} ₽/клик) ~${Math.round(extraRub)} ₽. Топ: ${top}. ` +
        `Списываемая цена пробивает потолок (надбавка/множители ставок) — ставки не трогаю, но это утечка бюджета.`,
    }
  }

  return { over, overCount: over.length, extraRub, alert }
}
