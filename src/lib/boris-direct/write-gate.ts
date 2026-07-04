// Write-gate роли «трафик» (Борис-Директ): ЕДИНСТВЕННАЯ дверь для пишущих
// запросов в Директ. НИ ОДИН write не уходит мимо этого модуля.
//
// Правила двери:
// - mode OBSERVE → perform НЕ вызывается, пишем лог applied=false («сделал бы»);
// - frozen (стоп-кран «Борис, стоп») → блок, КРОМЕ emergency (защита денег
//   при катастрофе); в OBSERVE emergency всё равно не применяется;
// - LIVE и не frozen → perform() + лог applied=true;
// - КАЖДЫЙ вызов (применённый и нет) оставляет запись BorisDirectActionLog
//   с before/after — из неё работает откат (rollback.ts).

import { prisma } from '@/lib/db/prisma'
import type { Prisma } from '@prisma/client'
import { getDirectRoleState } from './state'
import {
  setKeywordBids,
  updateCampaignNegatives,
  restoreMetricaTag,
  suspendKeywords,
  suspendCampaign,
  updateDailyBudget,
} from './direct-client'
import { BID_CEILING_MICRO, DIRECT_CAMPAIGN_ID, MICRO } from './config'
import { checkCircuitBreaker } from './rules'

export interface GateResult {
  applied: boolean
  logId: string
}

/** unknown → Json для Prisma (undefined остаётся undefined — поле не пишем). */
function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

export interface ExecuteDirectWriteOptions {
  action: string
  targetType: 'keyword' | 'campaign' | 'adgroup'
  targetId?: string
  before?: unknown
  after?: unknown
  reason: string
  perform: () => Promise<unknown>
  /** Аварийный write (защита денег): проходит сквозь frozen, но НЕ сквозь OBSERVE. */
  emergency?: boolean
  /** id записи лога, которую откатывает этот write (проставляет rollback). */
  revertOfId?: string
}

/**
 * Пропускает пишущий запрос через гейт режима и логирует результат.
 *
 * Ошибка perform → запись applied=false с ' | ERROR: ...' в reason,
 * исключение пробрасывается вызывающему.
 */
export async function executeDirectWrite(opts: ExecuteDirectWriteOptions): Promise<GateResult> {
  const state = await getDirectRoleState()
  const blockedByFreeze = state.frozen && !opts.emergency
  const canApply = state.mode === 'LIVE' && !blockedByFreeze

  const base = {
    action: opts.action,
    targetType: opts.targetType,
    targetId: opts.targetId,
    before: toJson(opts.before),
    after: toJson(opts.after),
    mode: state.mode,
    revertOfId: opts.revertOfId,
  }

  if (!canApply) {
    // «Сделал бы»: applied=false + mode в записи говорят сами за себя.
    const log = await prisma.borisDirectActionLog.create({
      data: { ...base, reason: opts.reason, applied: false },
    })
    return { applied: false, logId: log.id }
  }

  try {
    await opts.perform()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await prisma.borisDirectActionLog.create({
      data: { ...base, reason: `${opts.reason} | ERROR: ${message}`, applied: false },
    })
    throw err
  }

  const log = await prisma.borisDirectActionLog.create({
    data: { ...base, reason: opts.reason, applied: true },
  })
  return { applied: true, logId: log.id }
}

// ---------- Ставки ----------

export interface BidChange {
  keywordId: number
  fromMicro: number
  toMicro: number
}

export interface ApplyBidsResult extends GateResult {
  /** Сколько ставок было срезано до потолка (>0 = ошибка программы выше по стеку). */
  clamped: number
  /** Circuit breaker не пропустил пачку — НЕ применено, вызывающий шлёт владельцу. */
  breakerTripped: boolean
}

/**
 * Смена поисковых ставок через гейт: clamp каждой ставки к потолку
 * (BID_CEILING_MICRO — выше потолка означает баг, срезаем и ругаемся в лог),
 * затем circuit breaker ПЕРЕД гейтом (пачка вне паттерна → не применять
 * вовсе), затем executeDirectWrite('keywordbids.set').
 */
export async function applyBidChanges(
  changes: BidChange[],
  reason: string,
  revertOfId?: string
): Promise<ApplyBidsResult> {
  let clamped = 0
  const safe = changes.map((c) => {
    if (c.toMicro > BID_CEILING_MICRO) {
      clamped += 1
      console.warn(
        `[boris-direct/write-gate] ставка ${c.toMicro / MICRO} ₽ по фразе ${c.keywordId} выше потолка ${BID_CEILING_MICRO / MICRO} ₽ — ошибка программы, clamp до потолка`
      )
      return { ...c, toMicro: BID_CEILING_MICRO }
    }
    return c
  })

  const before = safe.map((c) => ({ keywordId: c.keywordId, bidMicro: c.fromMicro }))
  const after = safe.map((c) => ({ keywordId: c.keywordId, bidMicro: c.toMicro }))

  const breaker = checkCircuitBreaker(safe)
  if (!breaker.ok) {
    // Не применяем и не идём в гейт — но след в логе оставляем для разбора.
    const state = await getDirectRoleState()
    const log = await prisma.borisDirectActionLog.create({
      data: {
        action: 'keywordbids.set',
        targetType: 'keyword',
        before: toJson(before),
        after: toJson(after),
        reason: `${reason} | CIRCUIT BREAKER: ${breaker.reason}`,
        mode: state.mode,
        applied: false,
        revertOfId,
      },
    })
    return { applied: false, logId: log.id, clamped, breakerTripped: true }
  }

  const result = await executeDirectWrite({
    action: 'keywordbids.set',
    targetType: 'keyword',
    before,
    after,
    reason,
    revertOfId,
    perform: () =>
      setKeywordBids(safe.map((c) => ({ keywordId: c.keywordId, searchBidMicro: c.toMicro }))),
  })

  return { ...result, clamped, breakerTripped: false }
}

// ---------- Минус-фразы ----------

/**
 * Замена списка минус-фраз кампании через гейт. newFullList ЗАМЕЩАЕТ текущий
 * список целиком (семантика campaigns.update) — вызывающий обязан передать
 * объединённый набор; previousFullList уходит в before для отката.
 *
 * После применённого campaigns.update СРАЗУ возвращаем ADD_METRICA_TAG=YES:
 * тег слетает после любого апдейта TextCampaign. NegativeKeywords живёт на
 * верхнем уровне Campaign и, возможно, тег НЕ сбивает — но по ТЗ страхуемся
 * после КАЖДОГО campaigns.update.
 */
export async function applyNegativeKeywords(
  newFullList: string[],
  previousFullList: string[],
  reason: string,
  revertOfId?: string
): Promise<GateResult> {
  const result = await executeDirectWrite({
    action: 'campaigns.update.negatives',
    targetType: 'campaign',
    targetId: String(DIRECT_CAMPAIGN_ID),
    before: previousFullList,
    after: newFullList,
    reason,
    revertOfId,
    perform: () => updateCampaignNegatives(newFullList),
  })

  if (result.applied) {
    await executeDirectWrite({
      action: 'campaigns.update.metrica_tag_restore',
      targetType: 'campaign',
      targetId: String(DIRECT_CAMPAIGN_ID),
      reason: 'страховка: вернуть ADD_METRICA_TAG=YES после campaigns.update',
      perform: () => restoreMetricaTag(),
    })
  }

  return result
}

// ---------- Остановки ----------

/** Остановка ключевых фраз через гейт (обратной операции у Бориса НЕТ — resume вне набора). */
export async function suspendKeywordsGated(ids: number[], reason: string): Promise<GateResult> {
  return executeDirectWrite({
    action: 'keywords.suspend',
    targetType: 'keyword',
    targetId: ids.join(','),
    after: { suspendedIds: ids },
    reason,
    perform: () => suspendKeywords(ids),
  })
}

/**
 * АВАРИЙНАЯ остановка всей кампании — только катастрофа (неуправляемый расход).
 * emergency=true: проходит даже сквозь frozen — защита денег важнее стоп-крана.
 * В OBSERVE всё равно не применяется (наблюдение денег не тратит).
 */
export async function suspendCampaignEmergency(reason: string): Promise<GateResult> {
  return executeDirectWrite({
    action: 'campaigns.suspend',
    targetType: 'campaign',
    targetId: String(DIRECT_CAMPAIGN_ID),
    reason,
    emergency: true,
    perform: () => suspendCampaign(),
  })
}

// ---------- Дневной бюджет ----------

/**
 * Смена дневного бюджета через гейт.
 *
 * ТОЛЬКО после явного «да» владельца, из обработчика решения по предложению —
 * brain это НЕ вызывает никогда (инвариант: DailyBudget меняет владелец).
 * После применённого campaigns.update страхуемся restoreMetricaTag.
 */
export async function applyDailyBudget(amountMicro: number, reason: string): Promise<GateResult> {
  const result = await executeDirectWrite({
    action: 'campaigns.update.daily_budget',
    targetType: 'campaign',
    targetId: String(DIRECT_CAMPAIGN_ID),
    after: { amountMicro },
    reason,
    perform: () => updateDailyBudget(amountMicro),
  })

  if (result.applied) {
    await executeDirectWrite({
      action: 'campaigns.update.metrica_tag_restore',
      targetType: 'campaign',
      targetId: String(DIRECT_CAMPAIGN_ID),
      reason: 'страховка: вернуть ADD_METRICA_TAG=YES после campaigns.update',
      perform: () => restoreMetricaTag(),
    })
  }

  return result
}
