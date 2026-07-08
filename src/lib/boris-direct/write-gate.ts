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
  getCampaignSettings,
} from './direct-client'
import { BID_CEILING_MICRO, DIRECT_CAMPAIGN_ID, MICRO } from './config'
import { checkCircuitBreaker, prepareMinusCandidates, isSuspiciousNegativesShrink } from './rules'

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
 * НИЗКОУРОВНЕВОЙ примитив «поставить ТОЧНЫЙ список минус-фраз». newFullList
 * ЗАМЕЩАЕТ текущий список целиком (семантика campaigns.update); previousFullList
 * уходит в before для отката.
 *
 * ВНИМАНИЕ: это SET-EXACT — он шлёт РОВНО то, что дали, и НЕ мержит с кабинетом.
 * Для ДОБАВЛЕНИЯ минус-фраз (принятое предложение, автономная минусовка) НЕЛЬЗЯ
 * звать его напрямую — иначе живой список кабинета будет затёрт. Используй
 * addNegativeKeywords (единая точка мержа с живым списком). Прямой вызов
 * допустим ТОЛЬКО для восстановления точного списка (rollback) и изнутри
 * addNegativeKeywords.
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

export interface AddNegativesResult {
  applied: boolean
  logId: string | null
  /** Fail-safe: живой список не прочитан / подозрительно усох → запись отменена, кабинет не тронут. */
  aborted: boolean
  /** Причина аборта (для аномалии владельцу) — заполнена только при aborted. */
  abortReason?: string
  /** Сколько НЕТТО-новых фраз добавлено (0 = все уже в списке или отмена → записи не было). */
  added: number
  /** Контрольное чтение после ПРИМЕНЁННОГО write: счётчик кабинета != размеру объединения. */
  verifyMismatch?: boolean
}

/**
 * ЕДИНАЯ ТОЧКА добавления минус-фраз. Что бы ни просили добавить, в кабинет
 * уходит ОБЪЕДИНЕНИЕ живого списка (СВЕЖИЙ campaigns.get в момент применения —
 * не из памяти/снапшота/лога) и новых фраз. Так ни один вызывающий не может
 * физически затереть живой список кабинета: замещающий список всегда строится
 * ЗДЕСЬ поверх реального содержимого кабинета.
 *
 * FAIL-SAFE (дефолт при сомнении — бездействие, НЕ запись):
 *  - живой список не прочитался (ошибка/пусто) → отмена, aborted;
 *  - живой список подозрительно усох против последнего campaign_settings-снапшота
 *    (уже кто-то снёс) → отмена, aborted.
 * В обоих случаях write НЕ выполняется, кабинет не трогается, вызывающий шлёт
 * владельцу аномалию.
 *
 * Валидация фраз (механика Директа) и дедуп против живого списка —
 * переиспользованный prepareMinusCandidates. before лога = свежий живой список
 * (откат восстанавливает именно его). После применённого write — контрольное
 * чтение: размер кабинета должен совпасть с размером объединения.
 */
export async function addNegativeKeywords(
  phrasesToAdd: string[],
  reason: string
): Promise<AddNegativesResult> {
  // 1. СВЕЖИЙ живой список ИЗ КАБИНЕТА (не память/снапшот/лог).
  let live: string[] | null = null
  try {
    const settings = await getCampaignSettings()
    live = settings.NegativeKeywords?.Items ?? null
  } catch (err) {
    console.error('[boris-direct/write-gate] addNegativeKeywords: живой минус-список не прочитан', err)
    live = null
  }
  // FAIL-SAFE 1: чтение не удалось (campaigns.get упал ИЛИ поле NegativeKeywords
  // отсутствует/null) → НЕ пишем, иначе затрём кабинет. Пустой массив (Items: [])
  // сюда НЕ попадает — он допустим для молодой кампании; катастрофу «внезапно 0
  // при непустом снапшоте» ловит FAIL-SAFE 2 (isSuspiciousNegativesShrink).
  if (live === null) {
    return {
      applied: false,
      logId: null,
      aborted: true,
      added: 0,
      abortReason:
        'живой минус-список кабинета не прочитан (campaigns.get упал или поле NegativeKeywords отсутствует) — минусовку отменил, список кабинета не трогаю',
    }
  }

  // FAIL-SAFE 2: живой список подозрительно усох против последнего снапшота.
  let snapshotCount: number | null = null
  try {
    const snap = await prisma.borisDirectSnapshot.findFirst({
      where: { kind: 'campaign_settings' },
      orderBy: [{ tickDate: 'desc' }, { createdAt: 'desc' }],
    })
    const payload = snap?.payload as { NegativeKeywords?: { Items?: string[] } } | undefined
    snapshotCount = payload?.NegativeKeywords?.Items?.length ?? null
  } catch (err) {
    console.error('[boris-direct/write-gate] addNegativeKeywords: снапшот campaign_settings недоступен', err)
    snapshotCount = null
  }
  if (isSuspiciousNegativesShrink(live.length, snapshotCount)) {
    return {
      applied: false,
      logId: null,
      aborted: true,
      added: 0,
      abortReason: `живой минус-список подозрительно усох: сейчас ${live.length}, в снапшоте было ${snapshotCount} — минусовку отменил, список кабинета не трогаю`,
    }
  }

  // 2. Валидация (механика Директа) + дедуп против ЖИВОГО списка.
  const prepared = prepareMinusCandidates(phrasesToAdd, { coreKeywords: [], existingMinus: live })
  if (prepared.accepted.length === 0) {
    // Всё уже в кабинете (или отсеяно механикой) — писать нечего, кабинет не трогаем.
    return { applied: false, logId: null, aborted: false, added: 0 }
  }

  // 3. ОБЪЕДИНЕНИЕ живого списка и новых фраз — единственный список в кабинет.
  const merged = [...live, ...prepared.accepted]
  const gate = await applyNegativeKeywords(merged, live, reason)

  // 4. Контрольное чтение после ПРИМЕНЁННОГО write. Проверяем ГЛАВНЫЙ инвариант
  // фикса: кабинет НЕ усох ниже живой базы (мы слали live ∪ new, значит фраз
  // должно быть НЕ МЕНЬШЕ live.length). Строгое «== merged.length» дало бы ложную
  // тревогу, если Яндекс схлопнул новую фразу по своей нормализации (это не
  // потеря базы). cabinetCount < live.length = реальная потеря → тревога.
  let verifyMismatch = false
  if (gate.applied) {
    try {
      const after = await getCampaignSettings()
      const cabinetCount = after.NegativeKeywords?.Items?.length ?? -1
      if (cabinetCount < live.length) verifyMismatch = true
    } catch (err) {
      console.error('[boris-direct/write-gate] addNegativeKeywords: контрольное чтение упало', err)
      verifyMismatch = true
    }
  }

  return {
    applied: gate.applied,
    logId: gate.logId,
    aborted: false,
    added: prepared.accepted.length,
    verifyMismatch,
  }
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
