import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { Actor } from '@/lib/orders/client-portions'
import {
  applyRangeLine,
  formatRangeAmount,
  formatRangePlanLines,
  isMultiLocationPlan,
  planRangeChange,
  rangeLineLabel,
  type RangeChangeRequest,
  type RangePlan,
} from '@/lib/orders/range-change'
import { formatWeeklyDate } from '@/lib/weekly/sanity-checks'
import { getActiveMaxChatIdForClient } from '@/lib/bot/max-users'

/**
 * Запрос клиента «с 7 по 14 +1 обед» / «всю неделю по 30»: план по
 * существующим заказам → менеджеру одно сообщение с кнопками. Запрос и итог
 * хранятся в ActivityLog (без новой таблицы): REQUESTED — план, RESOLVED —
 * решение менеджера. Гонка двух нажатий (два менеджера / «Подтвердить» и
 * «Отклонить» одновременно) закрыта атомарным claim: updateMany переводит
 * сам лог запроса REQUESTED → CLAIMED, выигрывает тот, у кого count=1.
 */

export const RANGE_REQUESTED_ACTION = 'ORDER_RANGE_CHANGE_REQUESTED'
/** Запрос забран одним нажатием — второе получает already_processed. */
export const RANGE_CLAIMED_ACTION = 'ORDER_RANGE_CHANGE_CLAIMED'
export const RANGE_RESOLVED_ACTION = 'ORDER_RANGE_CHANGE_RESOLVED'

export interface RangeRequestPayload {
  clientName: string
  rawText: string
  sourceMaxChatId: string
  request: RangeChangeRequest
  plan: RangePlan
}

export type SubmitRangeResult =
  | { kind: 'pending'; requestId: string; plan: RangePlan }
  | { kind: 'nothing'; plan: RangePlan; reason: string }

/** План + запись запроса. Нечего менять → причина для inbox. */
export async function submitClientRangeRequest(params: {
  clientId: string
  clientName: string
  rawText: string
  sourceMaxChatId: string
  request: RangeChangeRequest
  now?: Date
}): Promise<SubmitRangeResult> {
  const plan = await planRangeChange(params.request, params.now)
  if (plan.lines.length === 0) {
    const reasons = Array.from(new Set(plan.skipped.map((s) => s.reason)))
    return {
      kind: 'nothing',
      plan,
      reason: reasons.length > 0 ? reasons.join('; ') : 'на эти дни заказов нет',
    }
  }
  const payload: RangeRequestPayload = {
    clientName: params.clientName,
    rawText: params.rawText,
    sourceMaxChatId: params.sourceMaxChatId,
    request: params.request,
    plan,
  }
  const log = await prisma.activityLog.create({
    data: {
      userId: null,
      userRole: null,
      action: RANGE_REQUESTED_ACTION,
      entityType: 'Client',
      entityId: params.clientId,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  })
  return { kind: 'pending', requestId: log.id, plan }
}

/** Сообщение менеджеру (HTML-safe делает вызывающий через escape). */
export function formatRangeRequestText(payload: RangeRequestPayload): string {
  const { request } = payload
  const raw = payload.rawText.replace(/\s+/g, ' ').trim()
  return [
    `📩 ${payload.clientName}: изменение на период`,
    `💬 «${raw.length > 300 ? `${raw.slice(0, 299)}…` : raw}»`,
    '',
    `${formatWeeklyDate(request.dateFrom)} — ${formatWeeklyDate(request.dateTo)}, ${formatRangeAmount(request.mode, request.portions)}. Если подтвердить:`,
    ...formatRangePlanLines(payload.plan),
  ].join('\n')
}

async function loadRequest(requestId: string) {
  const log = await prisma.activityLog.findUnique({
    where: { id: requestId },
    select: { id: true, action: true, entityId: true, payload: true },
  })
  if (!log || (log.action !== RANGE_REQUESTED_ACTION && log.action !== RANGE_CLAIMED_ACTION)) return null
  return { clientId: log.entityId as string, payload: log.payload as unknown as RangeRequestPayload }
}

/** Атомарный claim: true — запрос наш, false — уже забран другим нажатием. */
async function claimRequest(requestId: string): Promise<boolean> {
  const claim = await prisma.activityLog.updateMany({
    where: { id: requestId, action: RANGE_REQUESTED_ACTION },
    data: { action: RANGE_CLAIMED_ACTION },
  })
  return claim.count === 1
}

export type ResolveRangeResult =
  | {
      ok: true
      managerText: string
      clientReply: string | null
      clientChatId: string | null
    }
  | { ok: false; reason: 'not_found' | 'already_processed' }

/** «✅ Подтвердить»: применяет план построчно, итог менеджеру и клиенту. */
export async function confirmRangeRequest(params: {
  requestId: string
  actor: Actor
  now?: Date
}): Promise<ResolveRangeResult> {
  const req = await loadRequest(params.requestId)
  if (!req) return { ok: false, reason: 'not_found' }
  if (!(await claimRequest(params.requestId))) return { ok: false, reason: 'already_processed' }
  await markResolved(params.requestId, params.actor, 'confirmed')

  const { plan } = req.payload
  const multi = isMultiLocationPlan(plan)
  const done: string[] = []
  const failed: string[] = []
  for (const line of plan.lines) {
    let r
    try {
      r = await applyRangeLine(params.actor, line, 'range_change', params.now)
    } catch (err) {
      r = { ok: false, note: err instanceof Error ? err.message : String(err) }
    }
    const label = rangeLineLabel(line, multi)
    if (r.ok) done.push(`${label} — ${line.next}`)
    else failed.push(`${label} — ${r.note}`)
  }

  const managerText = [
    `✅ ${req.payload.clientName}: изменено`,
    ...done.map((d) => `• ${d}`),
    ...(failed.length > 0 ? ['Не получилось:', ...failed.map((f) => `• ${f}`)] : []),
  ].join('\n')
  const clientReply =
    done.length > 0
      ? `Обновили: ${done.join('; ')}.` +
        (failed.length > 0 ? ' По остальным дням менеджер свяжется с вами.' : '')
      : 'Спасибо! Менеджер свяжется с вами по изменению.'
  const clientChatId =
    (await getActiveMaxChatIdForClient(req.clientId).catch(() => null)) ?? req.payload.sourceMaxChatId
  return { ok: true, managerText, clientReply, clientChatId }
}

/** «❌ Отклонить»: заказы не трогаем, клиенту — что менеджер свяжется. */
export async function rejectRangeRequest(params: {
  requestId: string
  actor: Actor
}): Promise<ResolveRangeResult> {
  const req = await loadRequest(params.requestId)
  if (!req) return { ok: false, reason: 'not_found' }
  if (!(await claimRequest(params.requestId))) return { ok: false, reason: 'already_processed' }
  await markResolved(params.requestId, params.actor, 'rejected')
  const clientChatId =
    (await getActiveMaxChatIdForClient(req.clientId).catch(() => null)) ?? req.payload.sourceMaxChatId
  return {
    ok: true,
    managerText: `❌ ${req.payload.clientName}: изменение на период отклонено, заказы не меняли.`,
    clientReply: 'Спасибо! Менеджер свяжется с вами по изменению.',
    clientChatId,
  }
}

async function markResolved(requestId: string, actor: Actor, decision: 'confirmed' | 'rejected') {
  await prisma.activityLog.create({
    data: {
      userId: actor.id,
      userRole: actor.role,
      action: RANGE_RESOLVED_ACTION,
      entityType: 'ActivityLog',
      entityId: requestId,
      payload: { decision },
    },
  })
}
