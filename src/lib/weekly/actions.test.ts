import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import type { ParseResult } from './parser'

/**
 * Недельная заявка: приём → построчное применение → откат. client-portions
 * реальный (там логика «есть заказ → обновить / нет → создать / 0 → отменить»),
 * мокаем БД и Core-функции заказов.
 */

const { mockPrisma, mockCore } = vi.hoisted(() => ({
  mockPrisma: {
    clientMealConfig: { findMany: vi.fn() },
    weeklyOrderSubmission: {
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    user: { findFirst: vi.fn() },
    order: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    menuCycle: { findFirst: vi.fn() },
    activityLog: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
  },
  mockCore: {
    cancelOrderCore: vi.fn(),
    createOneTimeOrderCore: vi.fn(),
    editOrderPortionsCore: vi.fn(),
    restoreOrderCore: vi.fn(),
  },
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/app/(app)/orders/actions', () => mockCore)

import {
  applyReviewedSubmission,
  processWeeklySubmission,
  rejectWeeklySubmission,
  undoWeeklyApply,
  WEEKLY_APPLIED_ACTION,
} from './actions'

// Понедельник 5 окт 2026, 10:00 МСК.
const NOW = new Date('2026-10-05T07:00:00.000Z')
const SYSTEM = { id: 'admin_pro_1', role: 'ADMIN_PRO' }

const CONFIG_ROW = {
  id: 'cfg_1',
  locationId: 'loc_1',
  mealType: 'LUNCH',
  pricePerPortion: new Prisma.Decimal(300),
  location: {
    name: 'Офис',
    sameDayDelivery: false,
    isActive: true,
    cutoffHourMsk: null,
    cutoffMinuteMsk: null,
  },
}

function parsed(items: ParseResult['items'], confidence = 0.9): ParseResult {
  return { items, dietaryNotes: null, confidence, reason: 'ok' }
}

let createdCounter = 0

beforeEach(() => {
  vi.clearAllMocks()
  createdCounter = 0
  mockPrisma.clientMealConfig.findMany.mockResolvedValue([CONFIG_ROW])
  mockPrisma.weeklyOrderSubmission.upsert.mockResolvedValue({ id: 'sub_1' })
  mockPrisma.weeklyOrderSubmission.update.mockResolvedValue({})
  mockPrisma.weeklyOrderSubmission.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.user.findFirst.mockResolvedValue(SYSTEM)
  mockPrisma.order.findFirst.mockResolvedValue(null)
  mockPrisma.order.update.mockResolvedValue({})
  // Меню на следующую неделю НЕ утверждено — заказы всё равно должны появиться.
  mockPrisma.menuCycle.findFirst.mockResolvedValue(null)
  mockPrisma.activityLog.create.mockResolvedValue({ id: 'log_apply_1' })
  mockPrisma.activityLog.findFirst.mockResolvedValue(null)
  mockCore.createOneTimeOrderCore.mockImplementation(async () => ({
    ok: true,
    data: { orderId: `order_new_${++createdCounter}` },
  }))
  mockCore.editOrderPortionsCore.mockResolvedValue({ ok: true, data: { editedAfterLock: false } })
  mockCore.cancelOrderCore.mockResolvedValue({ ok: true, data: undefined })
  mockCore.restoreOrderCore.mockResolvedValue({ ok: true, data: { editedAfterLock: false } })
})

describe('processWeeklySubmission — автоприменение', () => {
  it('БАГ до 01.10: меню не утверждено → раньше NEEDS_REVIEW и ноль заказов; теперь заказы создаются', async () => {
    const r = await processWeeklySubmission({
      clientId: 'client_1',
      source: 'TEXT',
      rawText: 'вт 30, ср 32',
      parsedResult: parsed([
        { date: '2026-10-06', portions: 30 },
        { date: '2026-10-07', portions: 32 },
      ]),
      now: NOW,
    })

    expect(r.status).toBe('AUTO_CONFIRMED')
    expect(mockCore.createOneTimeOrderCore).toHaveBeenCalledTimes(2)
    expect(mockCore.createOneTimeOrderCore).toHaveBeenCalledWith(SYSTEM, {
      clientId: 'client_1',
      locationId: 'loc_1',
      mealType: 'LUNCH',
      // @db.Date: UTC-полночь МСК-дня, не МСК-инстант
      deliveryDate: new Date('2026-10-06T00:00:00.000Z'),
      portions: 30,
      source: 'WEEKLY_AUTO',
      silent: true,
    })
    expect(r.applied?.outcomes.map((o) => o.result)).toEqual(['created', 'created'])
    // отсутствие меню — только пометка менеджеру
    expect(r.applied?.menuMissingDates).toEqual(['2026-10-06', '2026-10-07'])
  })

  it('заявка в понедельник на текущую неделю: сегодня пропущено, будущие дни внесены', async () => {
    const r = await processWeeklySubmission({
      clientId: 'client_1',
      source: 'TEXT',
      parsedResult: parsed([
        { date: '2026-10-05', portions: 30 },
        { date: '2026-10-06', portions: 31 },
      ]),
      now: NOW,
    })

    expect(r.status).toBe('AUTO_CONFIRMED')
    expect(r.applied?.outcomes).toEqual([
      { date: '2026-10-05', locationName: 'Офис', portions: 30, result: 'skipped', note: 'приём на эту дату уже закрыт' },
      { date: '2026-10-06', locationName: 'Офис', portions: 31, result: 'created', note: null },
    ])
    // неделя заявки — понедельник самой ранней даты (UTC-полночь)
    expect(mockPrisma.weeklyOrderSubmission.upsert.mock.calls[0][0].where).toEqual({
      clientId_weekStartDate: { clientId: 'client_1', weekStartDate: new Date('2026-10-05T00:00:00.000Z') },
    })
  })

  it('confidence 0.85 → автомат', async () => {
    const r = await processWeeklySubmission({
      clientId: 'client_1',
      source: 'TEXT',
      parsedResult: parsed([{ date: '2026-10-06', portions: 30 }], 0.85),
      now: NOW,
    })
    expect(r.status).toBe('AUTO_CONFIRMED')
  })

  it('confidence 0.7 → NEEDS_REVIEW, заказы не трогаются', async () => {
    const r = await processWeeklySubmission({
      clientId: 'client_1',
      source: 'TEXT',
      parsedResult: parsed([{ date: '2026-10-06', portions: 30 }], 0.7),
      now: NOW,
    })
    expect(r.status).toBe('NEEDS_REVIEW')
    expect(r.applied).toBeNull()
    expect(mockCore.createOneTimeOrderCore).not.toHaveBeenCalled()
    expect(mockPrisma.weeklyOrderSubmission.update).toHaveBeenCalledWith({
      where: { id: 'sub_1' },
      data: { status: 'NEEDS_REVIEW', failureReason: expect.stringContaining('0.70 ниже 0.8') },
    })
  })

  it('пересечение с существующим FIXED-заказом → обновление порций, не create', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'order_fixed' })
    mockPrisma.order.findUnique.mockResolvedValue({
      id: 'order_fixed',
      status: 'CONFIRMED',
      portions: 25,
      pricePerPortion: new Prisma.Decimal(300),
      updDocumentLink: null,
    })

    const r = await processWeeklySubmission({
      clientId: 'client_1',
      source: 'TEXT',
      parsedResult: parsed([{ date: '2026-10-06', portions: 30 }]),
      now: NOW,
    })

    expect(r.applied?.outcomes[0].result).toBe('updated')
    expect(mockCore.createOneTimeOrderCore).not.toHaveBeenCalled()
    expect(mockCore.editOrderPortionsCore).toHaveBeenCalledWith(SYSTEM, { orderId: 'order_fixed', portions: 30 })
    // «было» сохранено для отката
    const payload = mockPrisma.activityLog.create.mock.calls[0][0].data.payload
    expect(payload.undo).toEqual([
      {
        orderId: 'order_fixed',
        kind: 'updated',
        prevPortions: 25,
        prevStatus: 'CONFIRMED',
        newPortions: 30,
        newStatus: 'CONFIRMED',
      },
    ])
  })

  it('0 / «не нужно» → отмена существующего заказа через cancelOrderCore', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'order_fixed' })
    mockPrisma.order.findUnique.mockResolvedValue({
      id: 'order_fixed',
      status: 'CONFIRMED',
      portions: 25,
      pricePerPortion: new Prisma.Decimal(300),
      updDocumentLink: null,
    })

    const r = await processWeeklySubmission({
      clientId: 'client_1',
      source: 'TEXT',
      parsedResult: parsed([{ date: '2026-10-06', portions: 0 }]),
      now: NOW,
    })

    expect(r.applied?.outcomes[0].result).toBe('cancelled')
    expect(mockCore.cancelOrderCore).toHaveBeenCalledWith(SYSTEM, {
      orderId: 'order_fixed',
      reason: 'weekly_submission',
    })
  })

  it('ошибка по строке не глотается: итог «НЕ получилось» + failureReason', async () => {
    mockCore.createOneTimeOrderCore.mockResolvedValueOnce({ ok: false, error: 'Клиент в архиве' })

    const r = await processWeeklySubmission({
      clientId: 'client_1',
      source: 'TEXT',
      parsedResult: parsed([
        { date: '2026-10-06', portions: 30 },
        { date: '2026-10-07', portions: 32 },
      ]),
      now: NOW,
    })

    expect(r.applied?.outcomes.map((o) => [o.result, o.note])).toEqual([
      ['failed', 'Клиент в архиве'],
      ['created', null],
    ])
    expect(mockPrisma.weeklyOrderSubmission.update).toHaveBeenLastCalledWith({
      where: { id: 'sub_1' },
      data: { status: 'AUTO_CONFIRMED', failureReason: 'не внесено: 2026-10-06 — Клиент в архиве' },
    })
  })

  it('повторная заявка на ту же неделю: upsert (без P2002), гонка P2002 → повтор', async () => {
    mockPrisma.weeklyOrderSubmission.upsert
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      )
      .mockResolvedValueOnce({ id: 'sub_1' })

    const r = await processWeeklySubmission({
      clientId: 'client_1',
      source: 'TEXT',
      parsedResult: parsed([{ date: '2026-10-06', portions: 30 }]),
      now: NOW,
    })

    expect(r.submissionId).toBe('sub_1')
    expect(mockPrisma.weeklyOrderSubmission.upsert).toHaveBeenCalledTimes(2)
    const call = mockPrisma.weeklyOrderSubmission.upsert.mock.calls[1][0]
    expect(call.update).toMatchObject({ status: 'PARSED', failureReason: null, cancelledAt: null })
  })
})

describe('сообщение без строк заявки', () => {
  it('«спасибо» от WEEKLY-клиента не создаёт и не перезаписывает заявку', async () => {
    const r = await processWeeklySubmission({
      clientId: 'client_1',
      source: 'TEXT',
      rawText: 'спасибо!',
      parsedResult: parsed([], 0.2),
      now: NOW,
    })
    expect(r).toMatchObject({ submissionId: null, status: 'NOT_A_SUBMISSION', applied: null })
    expect(mockPrisma.weeklyOrderSubmission.upsert).not.toHaveBeenCalled()
    expect(mockPrisma.weeklyOrderSubmission.update).not.toHaveBeenCalled()
  })

  it('неделя заявки — по самой поздней дате («пт этой + пн следующей» → следующая)', async () => {
    await processWeeklySubmission({
      clientId: 'client_1',
      source: 'TEXT',
      parsedResult: parsed([
        { date: '2026-10-09', portions: 30 },
        { date: '2026-10-12', portions: 30 },
      ]),
      now: NOW,
    })
    expect(mockPrisma.weeklyOrderSubmission.upsert.mock.calls[0][0].where.clientId_weekStartDate.weekStartDate)
      .toEqual(new Date('2026-10-12T00:00:00.000Z'))
  })
})

describe('ручная проверка: «Внести как распознано» / «Отклонить»', () => {
  const ADMIN = { id: 'admin_pro_2', role: 'ADMIN_PRO' as const }

  it('кнопка вносит распознанное тем же путём, что и автомат', async () => {
    mockPrisma.weeklyOrderSubmission.findUniqueOrThrow.mockResolvedValue({
      clientId: 'client_1',
      parsedJson: parsed([{ date: '2026-10-06', portions: 30 }], 0.7),
    })

    const r = await applyReviewedSubmission({ submissionId: 'sub_1', actor: ADMIN, now: NOW })

    expect(r.ok).toBe(true)
    expect(mockPrisma.weeklyOrderSubmission.updateMany).toHaveBeenCalledWith({
      where: { id: 'sub_1', status: 'NEEDS_REVIEW' },
      data: { status: 'PARSED' },
    })
    expect(mockCore.createOneTimeOrderCore).toHaveBeenCalledWith(ADMIN, expect.objectContaining({ portions: 30 }))
    expect(mockPrisma.activityLog.create.mock.calls[0][0].data).toMatchObject({
      action: WEEKLY_APPLIED_ACTION,
      userId: 'admin_pro_2',
    })
  })

  it('повторное нажатие → already_processed, без дублей', async () => {
    mockPrisma.weeklyOrderSubmission.updateMany.mockResolvedValue({ count: 0 })
    mockPrisma.weeklyOrderSubmission.findUnique.mockResolvedValue({ id: 'sub_1' })

    const r = await applyReviewedSubmission({ submissionId: 'sub_1', actor: ADMIN, now: NOW })

    expect(r).toEqual({ ok: false, reason: 'already_processed' })
    expect(mockCore.createOneTimeOrderCore).not.toHaveBeenCalled()
  })

  it('«Отклонить» повторной заявки не отменяет ранее внесённое (статус → AUTO_CONFIRMED)', async () => {
    mockPrisma.activityLog.findFirst
      .mockResolvedValueOnce({ id: 'log_apply_1' }) // прежнее внесение
      .mockResolvedValueOnce(null) // не откатывалось
    const r = await rejectWeeklySubmission({ submissionId: 'sub_1', rejectedById: 'admin_pro_2' })
    expect(r).toEqual({ ok: true, keptPrevious: true })
    expect(mockPrisma.weeklyOrderSubmission.updateMany).toHaveBeenCalledWith({
      where: { id: 'sub_1', status: 'NEEDS_REVIEW' },
      data: { status: 'AUTO_CONFIRMED' },
    })
  })

  it('«Отклонить», когда прежнее внесение уже откатили → CANCELLED (напоминания снова нужны)', async () => {
    mockPrisma.activityLog.findFirst
      .mockResolvedValueOnce({ id: 'log_apply_1' })
      .mockResolvedValueOnce({ id: 'log_undo_1' })
    const r = await rejectWeeklySubmission({ submissionId: 'sub_1', rejectedById: 'admin_pro_2' })
    expect(r).toEqual({ ok: true, keptPrevious: false })
    expect(mockPrisma.weeklyOrderSubmission.updateMany.mock.calls[0][0].data.status).toBe('CANCELLED')
  })

  it('сбой при внесении по кнопке возвращает заявку в NEEDS_REVIEW (кнопку можно нажать снова)', async () => {
    mockPrisma.weeklyOrderSubmission.findUniqueOrThrow.mockResolvedValue({
      clientId: 'client_1',
      parsedJson: parsed([{ date: '2026-10-06', portions: 30 }], 0.7),
    })
    mockPrisma.activityLog.create.mockRejectedValueOnce(new Error('db blip'))

    await expect(applyReviewedSubmission({ submissionId: 'sub_1', actor: ADMIN, now: NOW })).rejects.toThrow('db blip')
    expect(mockPrisma.weeklyOrderSubmission.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'sub_1', status: 'PARSED' },
      data: { status: 'NEEDS_REVIEW' },
    })
  })

  it('«Отклонить» — CANCELLED только из NEEDS_REVIEW', async () => {
    const r = await rejectWeeklySubmission({ submissionId: 'sub_1', rejectedById: 'admin_pro_2' })
    expect(r.ok).toBe(true)
    expect(mockPrisma.weeklyOrderSubmission.updateMany).toHaveBeenCalledWith({
      where: { id: 'sub_1', status: 'NEEDS_REVIEW' },
      data: expect.objectContaining({ status: 'CANCELLED', cancelledById: 'admin_pro_2' }),
    })
  })
})

describe('«↩️ Отменить» — откат ровно к прежним значениям', () => {
  const ADMIN = { id: 'admin_pro_2', role: 'ADMIN_PRO' as const }

  function orderRow(id: string, status: string, portions: number) {
    return { id, status, portions, pricePerPortion: new Prisma.Decimal(300), updDocumentLink: null }
  }

  it('created → отмена, updated → прежние порции, confirmed → обратно в PENDING с 0', async () => {
    mockPrisma.activityLog.findUnique.mockResolvedValue({
      id: 'log_apply_1',
      action: WEEKLY_APPLIED_ACTION,
      entityId: 'sub_1',
      payload: {
        undo: [
          { orderId: 'o_created', kind: 'created', prevPortions: null, prevStatus: null, newPortions: 30, newStatus: 'CONFIRMED' },
          { orderId: 'o_updated', kind: 'updated', prevPortions: 25, prevStatus: 'CONFIRMED', newPortions: 30, newStatus: 'CONFIRMED' },
          { orderId: 'o_confirmed', kind: 'confirmed', prevPortions: 0, prevStatus: 'PENDING_CONFIRMATION', newPortions: 32, newStatus: 'CONFIRMED' },
        ],
      },
    })
    mockPrisma.order.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === 'o_created') return orderRow('o_created', 'CONFIRMED', 30)
      if (where.id === 'o_updated') return orderRow('o_updated', 'CONFIRMED', 30)
      return orderRow('o_confirmed', 'CONFIRMED', 32)
    })

    const r = await undoWeeklyApply({ applyLogId: 'log_apply_1', actor: ADMIN })

    expect(r.ok).toBe(true)
    expect(mockCore.cancelOrderCore).toHaveBeenCalledWith(ADMIN, {
      orderId: 'o_created',
      reason: 'Откат недельной заявки',
    })
    expect(mockCore.editOrderPortionsCore).toHaveBeenCalledWith(ADMIN, { orderId: 'o_updated', portions: 25 })
    const revert = mockPrisma.order.update.mock.calls.find((c) => c[0].where.id === 'o_confirmed')![0]
    expect(revert.data).toMatchObject({ status: 'PENDING_CONFIRMATION', portions: 0, confirmedAt: null })
    expect(mockPrisma.activityLog.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'WEEKLY_SUBMISSION_UNDONE' }),
      }),
    )
  })

  it('cancelled (было «не нужно») → восстановление и прежние порции', async () => {
    mockPrisma.activityLog.findUnique.mockResolvedValue({
      id: 'log_apply_1',
      action: WEEKLY_APPLIED_ACTION,
      entityId: 'sub_1',
      payload: {
        undo: [
          { orderId: 'o_c', kind: 'cancelled', prevPortions: 20, prevStatus: 'CONFIRMED', newPortions: 20, newStatus: 'CANCELLED' },
        ],
      },
    })
    mockPrisma.order.findUnique.mockResolvedValue(orderRow('o_c', 'CANCELLED', 20))

    await undoWeeklyApply({ applyLogId: 'log_apply_1', actor: ADMIN })

    expect(mockCore.restoreOrderCore).toHaveBeenCalledWith(ADMIN, { orderId: 'o_c' })
    expect(mockCore.editOrderPortionsCore).toHaveBeenCalledWith(ADMIN, { orderId: 'o_c', portions: 20 })
  })

  it('заказ с УПД не откатываем — в итоге с причиной', async () => {
    mockPrisma.activityLog.findUnique.mockResolvedValue({
      id: 'log_apply_1',
      action: WEEKLY_APPLIED_ACTION,
      entityId: 'sub_1',
      payload: {
        undo: [
          { orderId: 'o_upd', kind: 'updated', prevPortions: 25, prevStatus: 'CONFIRMED', newPortions: 30, newStatus: 'CONFIRMED' },
        ],
      },
    })
    mockPrisma.order.findUnique.mockResolvedValue({ ...orderRow('o_upd', 'CONFIRMED', 30), updDocumentLink: { id: 'u' } })

    const r = await undoWeeklyApply({ applyLogId: 'log_apply_1', actor: ADMIN })

    expect(r).toMatchObject({ ok: true, results: [{ orderId: 'o_upd', ok: false, note: 'по заказу уже выписан УПД' }] })
    expect(mockCore.editOrderPortionsCore).not.toHaveBeenCalled()
  })

  it('заказ изменён после внесения (повторная заявка/менеджер) → не трогаем; заявку не отменяем, если есть более позднее применение', async () => {
    mockPrisma.activityLog.findUnique.mockResolvedValue({
      id: 'log_apply_1',
      action: WEEKLY_APPLIED_ACTION,
      entityId: 'sub_1',
      createdAt: new Date('2026-10-05T07:00:00.000Z'),
      payload: {
        undo: [
          { orderId: 'o_x', kind: 'updated', prevPortions: 10, prevStatus: 'CONFIRMED', newPortions: 15, newStatus: 'CONFIRMED' },
        ],
      },
    })
    // повторная заявка B поставила 20
    mockPrisma.order.findUnique.mockResolvedValue(orderRow('o_x', 'CONFIRMED', 20))
    mockPrisma.activityLog.findFirst
      .mockResolvedValueOnce(null) // не отменялось
      .mockResolvedValueOnce({ id: 'log_apply_2' }) // есть более позднее применение

    const r = await undoWeeklyApply({ applyLogId: 'log_apply_1', actor: ADMIN })

    expect(r).toMatchObject({
      ok: true,
      results: [{ orderId: 'o_x', ok: false, note: 'заказ изменён после внесения — не трогаем' }],
    })
    expect(mockCore.editOrderPortionsCore).not.toHaveBeenCalled()
    expect(mockPrisma.weeklyOrderSubmission.update).not.toHaveBeenCalled()
  })

  it('повторная отмена того же применения → already_undone', async () => {
    mockPrisma.activityLog.findUnique.mockResolvedValue({
      id: 'log_apply_1',
      action: WEEKLY_APPLIED_ACTION,
      entityId: 'sub_1',
      payload: { undo: [] },
    })
    mockPrisma.activityLog.findFirst.mockResolvedValue({ id: 'log_undo_1' })

    const r = await undoWeeklyApply({ applyLogId: 'log_apply_1', actor: ADMIN })

    expect(r).toEqual({ ok: false, reason: 'already_undone' })
  })
})
