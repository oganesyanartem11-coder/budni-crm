import { prisma } from '@/lib/db/prisma'
import { Prisma } from '@prisma/client'
import type { OrderStatus, WeeklyOrderSubmissionStatus } from '@prisma/client'
import {
  applyPortionsByBusinessKey,
  IN_WORK_STATUSES,
  resolveSystemActor,
  type Actor,
} from '@/lib/orders/client-portions'
import { cancelOrderCore, editOrderPortionsCore, restoreOrderCore } from '@/app/(app)/orders/actions'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import type { ParseResult, ParserExistingOrder } from './parser'
import { WINDOW_DAYS } from './parser'
import {
  classifyWeeklyItems,
  mondayOf,
  weeklyPortionKey,
  type WeeklyConfigOption,
  type WeeklyLine,
} from './sanity-checks'

/**
 * Недельная заявка WEEKLY-клиента: приём, применение к заказам и откат.
 *
 * 01.10.2026 — корень «пишет даты, а заказы не появляются»:
 *  1. заказ создавался только при утверждённом меню на КАЖДУЮ дату (меню на
 *     следующую неделю обычно ещё не утверждено) → NEEDS_REVIEW, ноль заказов;
 *  2. даты принимались строго в следующей неделе (заявка в понедельник на
 *     текущую — вся на ручную проверку);
 *  3. порог уверенности 0.95 + коридор порций 50–200%;
 *  4. ручная проверка приходила менеджеру БЕЗ кнопок («создай вручную»);
 *  5. create без учёта уже существующих заказов (P2002 order_business_key).
 *
 * Теперь: построчный разбор (sanity-checks.ts), чистая заявка применяется сразу,
 * каждая строка — через applyPortionsByBusinessKey (есть заказ → обновить,
 * нет → создать, 0 → отменить), итог по строкам не глотается. Что было до
 * применения — в ActivityLog WEEKLY_SUBMISSION_APPLIED (для «↩️ Отменить»).
 */

export const WEEKLY_APPLIED_ACTION = 'WEEKLY_SUBMISSION_APPLIED'
export const WEEKLY_UNDONE_ACTION = 'WEEKLY_SUBMISSION_UNDONE'

export type WeeklyLineResult =
  | 'created'
  | 'updated'
  | 'confirmed'
  | 'cancelled'
  | 'unchanged'
  | 'noop'
  | 'skipped'
  | 'failed'

export interface WeeklyLineOutcome {
  date: string
  locationName: string | null
  portions: number
  result: WeeklyLineResult
  note: string | null
  /** Сколько было в заказе до внесения (для «34 → 35»); null — заказа не было. */
  prevPortions?: number | null
}

/**
 * Что было до применения — ровно то, что откатывает «↩️ Отменить». newPortions/
 * newStatus — что поставило применение: откат только если заказ с тех пор не
 * меняли (повторная заявка, менеджер, STICKY), иначе строка пропускается.
 */
export interface WeeklyUndoEntry {
  orderId: string
  kind: 'created' | 'updated' | 'confirmed' | 'cancelled'
  prevPortions: number | null
  prevStatus: OrderStatus | null
  newPortions: number
  newStatus: OrderStatus
}

export interface WeeklyApplyResult {
  applyLogId: string
  outcomes: WeeklyLineOutcome[]
  menuMissingDates: string[]
}

/** Активные WEEKLY-конфиги клиента на активных точках — варианты для строк. */
export async function loadWeeklyConfigOptions(clientId: string): Promise<WeeklyConfigOption[]> {
  const configs = await prisma.clientMealConfig.findMany({
    where: { clientId, orderType: 'WEEKLY', isActive: true, location: { isActive: true } },
    include: { location: true },
    orderBy: { createdAt: 'asc' },
  })
  return configs.map((c) => ({
    configId: c.id,
    locationId: c.locationId,
    locationName: c.location.name,
    mealType: c.mealType,
    pricePerPortion: Number(c.pricePerPortion),
    location: {
      sameDayDelivery: c.location.sameDayDelivery,
      isActive: c.location.isActive,
      cutoffHourMsk: c.location.cutoffHourMsk,
      cutoffMinuteMsk: c.location.cutoffMinuteMsk,
    },
  }))
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Уже внесённые (не отменённые) заказы WEEKLY-питания клиента на окно заявки:
 * парсеру — чтобы разложить «добавьте 1 с 7-го» по дням, разбору — база для
 * прибавки. Ключ — weeklyPortionKey (точка + приём + дата).
 */
export async function loadUpcomingWeeklyOrders(
  clientId: string,
  configs: WeeklyConfigOption[],
  now: Date,
): Promise<{ list: ParserExistingOrder[]; byKey: Map<string, number> }> {
  const byKey = new Map<string, number>()
  const list: ParserExistingOrder[] = []
  if (configs.length === 0) return { list, byKey }
  const today = getMskCalendarDayUtc(now, 0)
  const orders = await prisma.order.findMany({
    where: {
      clientId,
      deliveryDate: { gte: today, lte: new Date(today.getTime() + WINDOW_DAYS * DAY_MS) },
      status: { not: 'CANCELLED' },
      OR: configs.map((c) => ({ locationId: c.locationId, mealType: c.mealType })),
    },
    select: { locationId: true, mealType: true, deliveryDate: true, portions: true },
    orderBy: { deliveryDate: 'asc' },
  })
  for (const o of orders) {
    const date = o.deliveryDate.toISOString().slice(0, 10)
    byKey.set(weeklyPortionKey(o.locationId, o.mealType, date), o.portions)
    const config = configs.find((c) => c.locationId === o.locationId && c.mealType === o.mealType)
    list.push({ date, locationId: o.locationId, locationName: config?.locationName ?? '', portions: o.portions })
  }
  return { list, byKey }
}

/**
 * Неделя заявки — понедельник САМОЙ ПОЗДНЕЙ распознанной даты (UTC-полночь
 * МСК-дня): заявка «чт этой + пн–пт следующей» относится к следующей неделе,
 * как её ищут напоминания. Без дат — понедельник текущей недели.
 */
export function resolveWeekStartDate(lines: WeeklyLine[], now: Date): Date {
  const dates = lines
    .map((l) => l.deliveryDate)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())
  return mondayOf(dates[0] ?? getMskCalendarDayUtc(now, 0))
}

/**
 * Upsert по @@unique(clientId, weekStartDate): повторная заявка на ту же неделю
 * перезаписывает предыдущую (без P2002) и затем применяется заново — строки
 * идемпотентны (то же число → «без изменений»).
 */
async function upsertSubmission(data: {
  clientId: string
  weekStartDate: Date
  source: 'PHOTO' | 'TEXT'
  blobUrl?: string
  rawText?: string
  parsedResult: ParseResult
}): Promise<{ id: string }> {
  const fields = {
    source: data.source,
    blobUrl: data.blobUrl ?? null,
    rawText: data.rawText ?? null,
    parsedJson: data.parsedResult as unknown as Prisma.InputJsonValue,
    confidence: data.parsedResult.confidence,
    notes: data.parsedResult.dietaryNotes ?? null,
    status: 'PARSED' as const,
    failureReason: null,
    managerNotifiedAt: null,
    cancelledAt: null,
    cancelledById: null,
  }
  const where = {
    clientId_weekStartDate: { clientId: data.clientId, weekStartDate: data.weekStartDate },
  }
  const run = () =>
    prisma.weeklyOrderSubmission.upsert({
      where,
      create: { clientId: data.clientId, weekStartDate: data.weekStartDate, ...fields },
      update: fields,
      select: { id: true },
    })
  try {
    return await run()
  } catch (err) {
    // Гонка двух одновременных create → второй получает P2002; повтор = update.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return run()
    throw err
  }
}

export interface ProcessWeeklyResult {
  /** null — в сообщении нет ни одной строки заявки: заявку не создаём и не перезаписываем. */
  submissionId: string | null
  status: WeeklyOrderSubmissionStatus | 'NOT_A_SUBMISSION'
  lines: WeeklyLine[]
  reviewReasons: string[]
  applied: WeeklyApplyResult | null
}

export async function processWeeklySubmission(params: {
  clientId: string
  source: 'PHOTO' | 'TEXT'
  blobUrl?: string
  rawText?: string
  parsedResult: ParseResult
  now?: Date
}): Promise<ProcessWeeklyResult> {
  const now = params.now ?? new Date()
  const configs = await loadWeeklyConfigOptions(params.clientId)
  const { byKey } = await loadUpcomingWeeklyOrders(params.clientId, configs, now)
  const classification = classifyWeeklyItems(params.parsedResult, configs, now, byKey)
  // «Спасибо», вопрос, нечитаемое фото — ни одной строки. Upsert тут затёр бы
  // настоящую заявку текущей недели, поэтому заявку не трогаем вовсе.
  if (classification.lines.length === 0) {
    return {
      submissionId: null,
      status: 'NOT_A_SUBMISSION',
      lines: [],
      reviewReasons: classification.reviewReasons,
      applied: null,
    }
  }
  const weekStartDate = resolveWeekStartDate(classification.lines, now)

  const submission = await upsertSubmission({
    clientId: params.clientId,
    weekStartDate,
    source: params.source,
    blobUrl: params.blobUrl,
    rawText: params.rawText,
    parsedResult: params.parsedResult,
  })

  const reviewReasons = [...classification.reviewReasons]
  const actor = classification.autoApply ? await resolveSystemActor() : null
  if (classification.autoApply && !actor) {
    reviewReasons.push('нет активного ADMIN_PRO для автоматического внесения')
  }

  if (reviewReasons.length > 0 || !actor) {
    const modelReason = params.parsedResult.reason ? ` (распознавание: ${params.parsedResult.reason})` : ''
    await prisma.weeklyOrderSubmission.update({
      where: { id: submission.id },
      data: { status: 'NEEDS_REVIEW', failureReason: reviewReasons.join('; ') + modelReason },
    })
    return {
      submissionId: submission.id,
      status: 'NEEDS_REVIEW',
      lines: classification.lines,
      reviewReasons,
      applied: null,
    }
  }

  const applied = await applyWeeklyLines({
    submissionId: submission.id,
    clientId: params.clientId,
    lines: classification.lines,
    actor,
    auto: true,
    notes: params.parsedResult.dietaryNotes,
  })
  return {
    submissionId: submission.id,
    status: 'AUTO_CONFIRMED',
    lines: classification.lines,
    reviewReasons: [],
    applied,
  }
}

/** APPROVED-меню на дату: только пометка менеджеру, заказ создаётся и без него. */
async function hasApprovedMenu(date: Date): Promise<boolean> {
  const menu = await prisma.menuCycle.findFirst({
    where: { status: 'APPROVED', validFrom: { lte: date }, validTo: { gte: date } },
    select: { id: true },
  })
  return menu !== null
}

/**
 * Применяет строки заявки. ok-строки — через applyPortionsByBusinessKey, skip/
 * blocked — в итог как «пропущено (причина)». Ошибки по строке не глотаются:
 * попадают в итог и failureReason заявки.
 */
export async function applyWeeklyLines(params: {
  submissionId: string
  clientId: string
  lines: WeeklyLine[]
  actor: Actor
  auto: boolean
  notes?: string | null
}): Promise<WeeklyApplyResult> {
  const { submissionId, clientId, lines, actor, auto, notes } = params
  const outcomes: WeeklyLineOutcome[] = []
  const undo: WeeklyUndoEntry[] = []
  const menuMissingDates: string[] = []

  for (const line of lines) {
    const locationName = line.config?.locationName ?? null
    if (line.status !== 'ok' || !line.config || !line.deliveryDate) {
      outcomes.push({
        date: line.date,
        locationName,
        portions: line.portions,
        result: 'skipped',
        note: line.note,
      })
      continue
    }

    try {
      const r = await applyPortionsByBusinessKey(actor, {
        clientId,
        locationId: line.config.locationId,
        mealType: line.config.mealType,
        deliveryDate: line.deliveryDate,
        portions: line.portions,
        source: 'WEEKLY_AUTO',
        via: 'weekly_submission',
        weeklySubmissionId: submissionId,
        sourceConfigId: line.config.configId,
        notes: notes ?? null,
      })
      if (r.ok) {
        outcomes.push({
          date: line.date,
          locationName,
          portions: line.portions,
          result: r.kind,
          note: null,
          prevPortions: r.prevPortions,
        })
        if (r.orderId && (r.kind === 'created' || r.kind === 'updated' || r.kind === 'confirmed' || r.kind === 'cancelled')) {
          undo.push({
            orderId: r.orderId,
            kind: r.kind,
            prevPortions: r.prevPortions,
            prevStatus: r.prevStatus,
            newPortions: r.kind === 'cancelled' ? (r.prevPortions ?? 0) : line.portions,
            newStatus: r.kind === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
          })
        }
        if (line.portions > 0 && !(await hasApprovedMenu(line.deliveryDate))) {
          menuMissingDates.push(line.date)
        }
      } else {
        outcomes.push({
          date: line.date,
          locationName,
          portions: line.portions,
          result: r.skipped ? 'skipped' : 'failed',
          note: r.skipped ? r.reason : r.error,
        })
      }
    } catch (err) {
      outcomes.push({
        date: line.date,
        locationName,
        portions: line.portions,
        result: 'failed',
        note: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const failures = outcomes.filter((o) => o.result === 'failed')
  await prisma.weeklyOrderSubmission.update({
    where: { id: submissionId },
    data: {
      status: 'AUTO_CONFIRMED',
      failureReason: failures.length
        ? `не внесено: ${failures.map((f) => `${f.date} — ${f.note}`).join('; ')}`
        : null,
    },
  })

  const log = await prisma.activityLog.create({
    data: {
      userId: auto ? null : actor.id,
      userRole: auto ? null : actor.role,
      action: WEEKLY_APPLIED_ACTION,
      entityType: 'WeeklyOrderSubmission',
      entityId: submissionId,
      payload: { auto, outcomes, undo } as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  })

  return { applyLogId: log.id, outcomes, menuMissingDates }
}

/** «✅ Внести как распознано» по заявке на ручной проверке. */
export async function applyReviewedSubmission(params: {
  submissionId: string
  actor: Actor
  now?: Date
}): Promise<
  | { ok: true; applied: WeeklyApplyResult; clientId: string }
  | { ok: false; reason: 'not_found' | 'already_processed' }
> {
  const claim = await prisma.weeklyOrderSubmission.updateMany({
    where: { id: params.submissionId, status: 'NEEDS_REVIEW' },
    data: { status: 'PARSED' },
  })
  if (claim.count === 0) {
    const exists = await prisma.weeklyOrderSubmission.findUnique({
      where: { id: params.submissionId },
      select: { id: true },
    })
    return { ok: false, reason: exists ? 'already_processed' : 'not_found' }
  }

  const submission = await prisma.weeklyOrderSubmission.findUniqueOrThrow({
    where: { id: params.submissionId },
    select: { clientId: true, parsedJson: true },
  })
  const parsed = submission.parsedJson as unknown as ParseResult
  const now = params.now ?? new Date()
  const configs = await loadWeeklyConfigOptions(submission.clientId)
  // «Добавьте 1» прибавляем к тому, что стоит в заказе СЕЙЧАС (пока заявка
  // ждала, заказ могли поменять).
  const { byKey } = await loadUpcomingWeeklyOrders(submission.clientId, configs, now)
  // Менеджер подтверждает распознанное — уверенность не гейтит, но даты/точки
  // перепроверяем на текущий момент (cut-off мог пройти, пока заявка ждала).
  const { lines } = classifyWeeklyItems({ ...parsed, confidence: 1 }, configs, now, byKey)

  try {
    const applied = await applyWeeklyLines({
      submissionId: params.submissionId,
      clientId: submission.clientId,
      lines,
      actor: params.actor,
      auto: false,
      notes: parsed.dietaryNotes,
    })
    return { ok: true, applied, clientId: submission.clientId }
  } catch (err) {
    // Не оставляем заявку в PARSED: кнопку можно будет нажать снова (строки идемпотентны).
    await prisma.weeklyOrderSubmission
      .updateMany({ where: { id: params.submissionId, status: 'PARSED' }, data: { status: 'NEEDS_REVIEW' } })
      .catch(() => {})
    throw err
  }
}

/** «❌ Отклонить» заявку на ручной проверке: заказы не вносились. */
export async function rejectWeeklySubmission(params: {
  submissionId: string
  rejectedById: string
}): Promise<{ ok: boolean; keptPrevious: boolean }> {
  // Повторная заявка на ту же неделю, отклонённая менеджером, не отменяет
  // ранее внесённую: статус возвращается в AUTO_CONFIRMED (заказы стоят,
  // напоминания по неделе не нужны).
  const lastApply = await prisma.activityLog.findFirst({
    where: { action: WEEKLY_APPLIED_ACTION, entityType: 'WeeklyOrderSubmission', entityId: params.submissionId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  const lastApplyUndone = lastApply
    ? await prisma.activityLog.findFirst({
        where: {
          action: WEEKLY_UNDONE_ACTION,
          entityType: 'WeeklyOrderSubmission',
          entityId: params.submissionId,
          payload: { path: ['applyLogId'], equals: lastApply.id },
        },
        select: { id: true },
      })
    : null
  // Действующее (не откатанное) прежнее внесение остаётся в силе.
  const applied = lastApply && !lastApplyUndone ? lastApply : null
  const claim = await prisma.weeklyOrderSubmission.updateMany({
    where: { id: params.submissionId, status: 'NEEDS_REVIEW' },
    data: applied
      ? { status: 'AUTO_CONFIRMED' }
      : { status: 'CANCELLED', cancelledById: params.rejectedById, cancelledAt: new Date() },
  })
  return { ok: claim.count === 1, keptPrevious: applied !== null }
}

export interface WeeklyUndoOutcome {
  orderId: string
  ok: boolean
  note: string | null
}

/**
 * «↩️ Отменить» конкретное применение: возвращает заказы ровно к значениям из
 * WeeklyUndoEntry. Заказ с УПД или уже в работе не трогаем — в итог с причиной.
 */
export async function undoWeeklyApply(params: {
  applyLogId: string
  actor: Actor
}): Promise<
  | { ok: true; submissionId: string; results: WeeklyUndoOutcome[] }
  | { ok: false; reason: 'not_found' | 'already_undone' }
> {
  const log = await prisma.activityLog.findUnique({ where: { id: params.applyLogId } })
  if (!log || log.action !== WEEKLY_APPLIED_ACTION || !log.entityId) {
    return { ok: false, reason: 'not_found' }
  }
  const submissionId = log.entityId
  const undone = await prisma.activityLog.findFirst({
    where: {
      action: WEEKLY_UNDONE_ACTION,
      entityType: 'WeeklyOrderSubmission',
      entityId: submissionId,
      payload: { path: ['applyLogId'], equals: params.applyLogId },
    },
    select: { id: true },
  })
  if (undone) return { ok: false, reason: 'already_undone' }

  const entries = ((log.payload as { undo?: WeeklyUndoEntry[] } | null)?.undo ?? []).slice().reverse()
  const results: WeeklyUndoOutcome[] = []
  for (const entry of entries) {
    try {
      results.push(await undoEntry(entry, params.actor))
    } catch (err) {
      results.push({
        orderId: entry.orderId,
        ok: false,
        note: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Заявку помечаем отменённой, только если это последнее её применение:
  // более поздняя повторная заявка на ту же неделю остаётся в силе.
  const laterApply = await prisma.activityLog.findFirst({
    where: {
      action: WEEKLY_APPLIED_ACTION,
      entityType: 'WeeklyOrderSubmission',
      entityId: submissionId,
      createdAt: { gt: log.createdAt },
    },
    select: { id: true },
  })
  if (!laterApply) {
    await prisma.weeklyOrderSubmission.update({
      where: { id: submissionId },
      data: { status: 'CANCELLED', cancelledById: params.actor.id, cancelledAt: new Date() },
    })
  }
  await prisma.activityLog.create({
    data: {
      userId: params.actor.id,
      userRole: params.actor.role,
      action: WEEKLY_UNDONE_ACTION,
      entityType: 'WeeklyOrderSubmission',
      entityId: submissionId,
      payload: { applyLogId: params.applyLogId, results } as unknown as Prisma.InputJsonValue,
    },
  })
  return { ok: true, submissionId, results }
}

async function undoEntry(entry: WeeklyUndoEntry, actor: Actor): Promise<WeeklyUndoOutcome> {
  const order = await prisma.order.findUnique({
    where: { id: entry.orderId },
    select: {
      id: true,
      status: true,
      portions: true,
      pricePerPortion: true,
      updDocumentLink: { select: { id: true } },
    },
  })
  const fail = (note: string): WeeklyUndoOutcome => ({ orderId: entry.orderId, ok: false, note })
  if (!order) return fail('заказ не найден')
  if (order.updDocumentLink) return fail('по заказу уже выписан УПД')
  if (IN_WORK_STATUSES.has(order.status)) return fail(`заказ уже в работе (${order.status})`)
  // Старые записи (до newStatus) не сверяем — их откат как раньше.
  if (entry.newStatus !== undefined) {
    const sameStatus = order.status === entry.newStatus
    const samePortions = entry.newStatus === 'CANCELLED' || order.portions === entry.newPortions
    if (!sameStatus || !samePortions) return fail('заказ изменён после внесения — не трогаем')
  }

  if (entry.kind === 'created') {
    const r = await cancelOrderCore(actor, { orderId: order.id, reason: 'Откат недельной заявки' })
    return r.ok ? { orderId: order.id, ok: true, note: null } : fail(r.error)
  }

  if (entry.kind === 'cancelled' && order.status === 'CANCELLED') {
    const r = await restoreOrderCore(actor, { orderId: order.id })
    if (!r.ok) return fail(r.error)
  }

  const prevPortions = entry.prevPortions ?? 0
  const prevStatus = entry.prevStatus ?? 'CONFIRMED'
  if (prevStatus === 'CONFIRMED') {
    const r = await editOrderPortionsCore(actor, { orderId: order.id, portions: prevPortions })
    return r.ok ? { orderId: order.id, ok: true, note: null } : fail(r.error)
  }

  // Был PENDING_CONFIRMATION/DRAFT (DYNAMIC-хвост): Core для «вернуть в ожидание»
  // нет — возвращаем статус и порции напрямую, с записью в ActivityLog.
  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: prevStatus,
      portions: prevPortions,
      totalPrice: order.pricePerPortion.mul(prevPortions),
      confirmedAt: null,
    },
  })
  await prisma.activityLog.create({
    data: {
      userId: actor.id,
      userRole: actor.role,
      action: 'ORDER_REVERTED_WEEKLY_UNDO',
      entityType: 'Order',
      entityId: order.id,
      payload: { fromStatus: order.status, toStatus: prevStatus, portions: prevPortions },
    },
  })
  return { orderId: order.id, ok: true, note: null }
}

/**
 * Старая кнопка «Отменить заявку» (wsub:cancel) на сообщениях до 01.10.2026:
 * CONFIRMED-заказы заявки → DRAFT, всё залоченное не трогаем.
 */
export async function cancelWeeklySubmission(params: {
  submissionId: string
  cancelledById: string
}): Promise<{
  cancelled: number
  notCancelled: { orderId: string; status: OrderStatus }[]
}> {
  const { submissionId, cancelledById } = params

  const submission = await prisma.weeklyOrderSubmission.findUnique({
    where: { id: submissionId },
    include: {
      orders: { select: { id: true, status: true, updDocumentLink: { select: { id: true } } } },
    },
  })

  if (!submission) {
    return { cancelled: 0, notCancelled: [] }
  }

  let cancelled = 0
  const notCancelled: { orderId: string; status: OrderStatus }[] = []

  for (const order of submission.orders) {
    if (order.status === 'CONFIRMED' && !order.updDocumentLink) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'DRAFT' },
      })
      cancelled++
    } else {
      notCancelled.push({ orderId: order.id, status: order.status })
    }
  }

  await prisma.weeklyOrderSubmission.update({
    where: { id: submissionId },
    data: { status: 'CANCELLED', cancelledById, cancelledAt: new Date() },
  })

  return { cancelled, notCancelled }
}
