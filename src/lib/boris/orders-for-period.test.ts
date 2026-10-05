import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Баг 05.10: «Шенаурина, с 6 по 14 по 9 завтраков, обедов, ужинов» — Боря 5 раз
 * писал «Создаю 27 заказов», но не создавал ни одного. Модель пыталась выдать
 * 27 вызовов create_one_time_order, ответ обрывался по max_tokens (2048),
 * pending-плана не было. Фикс: create_orders_for_period (один вызов → пачка
 * upsert_order_portions), сбор пачки в agent.ts, честный ответ при обрыве.
 */

const { mockPrisma, mockRunAgentLoop, mockApply } = vi.hoisted(() => ({
  mockPrisma: {
    client: { findUnique: vi.fn(), findMany: vi.fn() },
    clientLocation: { findUnique: vi.fn(), findFirst: vi.fn() },
    borisConversation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    borisMessage: { findMany: vi.fn(), create: vi.fn() },
    borisPendingAction: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  mockRunAgentLoop: vi.fn(),
  mockApply: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/llm/agent-loop', () => ({ runAgentLoop: mockRunAgentLoop }))
vi.mock('./metrics/track', () => ({ trackBorisCall: vi.fn(async () => {}) }))
vi.mock('@/lib/orders/client-portions', () => ({ applyPortionsByBusinessKey: mockApply }))

import { BORIS_TOOLS } from './tools'
import { chatWithBoris } from './agent'
import { executePendingAction } from './executor'

const periodTool = BORIS_TOOLS.find((t) => t.name === 'create_orders_for_period')!

const INPUT = {
  clientId: 'client_sh',
  locationId: 'loc_hotel',
  dateFrom: '2026-10-06',
  dateTo: '2026-10-14',
  items: [
    { mealType: 'DINNER', portions: 9, pricePerPortion: 200 },
    { mealType: 'BREAKFAST', portions: 9, pricePerPortion: 200 },
    { mealType: 'LUNCH', portions: 9, pricePerPortion: 400 },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-05T12:23:00.000Z')) // пн 15:23 МСК
  mockPrisma.client.findUnique.mockResolvedValue({ name: 'ИП Шенаурина', isActive: true })
  mockPrisma.clientLocation.findUnique.mockResolvedValue({
    name: 'Отель в Лобаново',
    clientId: 'client_sh',
    sameDayDelivery: false,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('create_orders_for_period', () => {
  it('6–14 окт × завтрак/обед/ужин → 27 строк upsert одним вызовом', async () => {
    const r = (await periodTool.execute(INPUT)) as {
      pending: true
      actions: Array<{ tool: string; input: Record<string, unknown> }>
      preview: string
    }

    expect(r.pending).toBe(true)
    expect(r.actions).toHaveLength(27)
    expect(r.actions[0]).toEqual({
      tool: 'upsert_order_portions',
      input: {
        clientId: 'client_sh',
        locationId: 'loc_hotel',
        mealType: 'BREAKFAST',
        deliveryDate: '2026-10-06',
        portions: 9,
        pricePerPortion: 200,
      },
    })
    expect(r.actions.at(-1)!.input).toMatchObject({ mealType: 'DINNER', deliveryDate: '2026-10-14' })
    expect(r.preview).toContain('ИП Шенаурина, Отель в Лобаново')
    expect(r.preview).toContain('06.10–14.10, каждый день (9 дн.)')
    expect(r.preview).toContain('— обед: 9 порций по 400 ₽')
    expect(r.preview).toContain('Всего заказов: 27')
  })

  it('weekdays [1..5] — только будни', async () => {
    const r = (await periodTool.execute({
      ...INPUT,
      dateFrom: '2026-10-06',
      dateTo: '2026-10-12',
      items: [{ mealType: 'LUNCH', portions: 9 }],
      weekdays: [1, 2, 3, 4, 5],
    })) as { actions: Array<{ input: { deliveryDate: string } }> }
    expect(r.actions.map((a) => a.input.deliveryDate)).toEqual([
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-12',
    ])
  })

  it('прошлое, перевёрнутый и слишком длинный период — ошибка, без плана', async () => {
    expect(await periodTool.execute({ ...INPUT, dateFrom: '2026-10-01' })).toEqual({
      ok: false,
      error: 'Период начинается в прошлом',
    })
    expect(await periodTool.execute({ ...INPUT, dateTo: '2026-10-05' })).toMatchObject({ ok: false })
    expect(await periodTool.execute({ ...INPUT, dateTo: '2026-12-01' })).toMatchObject({ ok: false })
  })

  it('точка чужого клиента — ошибка', async () => {
    mockPrisma.clientLocation.findUnique.mockResolvedValue({ name: 'X', clientId: 'other', sameDayDelivery: false })
    expect(await periodTool.execute(INPUT)).toEqual({ ok: false, error: 'location_not_found' })
  })
})

describe('chatWithBoris — сбор плана', () => {
  beforeEach(() => {
    mockPrisma.borisConversation.findFirst.mockResolvedValue({
      id: 'conv_1',
      lastMessageAt: new Date(),
    })
    mockPrisma.borisMessage.findMany.mockResolvedValue([])
    mockPrisma.borisMessage.create.mockResolvedValue({})
    mockPrisma.borisConversation.update.mockResolvedValue({})
    mockPrisma.borisPendingAction.create.mockResolvedValue({ id: 'pa_1' })
  })

  const base = { userId: 'u1', chatId: '1', chatType: 'private' as const, userRole: 'ADMIN_PRO' as const }

  it('пачка из create_orders_for_period → один pending с 27 действиями и одним пунктом превью', async () => {
    const toolResult = await periodTool.execute(INPUT)
    mockRunAgentLoop.mockResolvedValue({
      finalText: '',
      stopReason: 'end_turn',
      toolCalls: [{ name: 'create_orders_for_period', input: INPUT, result: toolResult }],
    })

    const r = await chatWithBoris({ ...base, userText: 'Шенаурина с 6 по 14 по 9' })

    expect(r.pendingActionId).toBe('pa_1')
    const saved = mockPrisma.borisPendingAction.create.mock.calls[0][0].data
    expect(saved.actions).toHaveLength(27)
    expect(saved.actions[0].tool).toBe('upsert_order_portions')
    expect(r.preview).toContain('📋 <b>Заказы на период</b>')
    expect(r.preview).not.toContain('Запланировано 27')
    // maxTokens поднят — 2048 не хватало на пачку вызовов
    expect(mockRunAgentLoop.mock.calls[0][0].maxTokens).toBe(4096)
  })

  it('обрыв по max_tokens без плана → честное сообщение, а не «создаю…»', async () => {
    mockRunAgentLoop.mockResolvedValue({
      finalText: 'Создаю 27 заказов — по 3 в день.',
      stopReason: 'max_tokens',
      toolCalls: [],
    })

    const r = await chatWithBoris({ ...base, userText: 'Создавай' })

    expect(r.pendingActionId).toBeUndefined()
    expect(r.reply).toContain('Не уместил план в один ответ — ничего не создано')
    expect(mockPrisma.borisPendingAction.create).not.toHaveBeenCalled()
  })
})

describe('executor — upsert_order_portions', () => {
  it('каждая строка через applyPortionsByBusinessKey; существующий заказ обновляется, ошибки по строке видны', async () => {
    mockPrisma.borisPendingAction.findUnique.mockResolvedValue({
      id: 'pa_1',
      conversationId: 'conv_1',
      conversation: { userId: 'u1' },
      expiresAt: new Date('2026-10-05T13:00:00.000Z'),
      actions: [
        {
          tool: 'upsert_order_portions',
          input: { clientId: 'c', locationId: 'l', mealType: 'BREAKFAST', deliveryDate: '2026-10-06', portions: 9, pricePerPortion: 200 },
        },
        {
          tool: 'upsert_order_portions',
          input: { clientId: 'c', locationId: 'l', mealType: 'LUNCH', deliveryDate: '2026-10-06', portions: 9 },
        },
        {
          tool: 'upsert_order_portions',
          input: { clientId: 'c', locationId: 'l', mealType: 'DINNER', deliveryDate: '2026-10-06', portions: 9 },
        },
      ],
    })
    mockPrisma.borisPendingAction.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'ADMIN_PRO' })
    mockApply
      .mockResolvedValueOnce({ ok: true, kind: 'created', orderId: 'o1', prevPortions: null, prevStatus: null })
      .mockResolvedValueOnce({ ok: true, kind: 'confirmed', orderId: 'o2', prevPortions: 0, prevStatus: 'PENDING_CONFIRMATION' })
      .mockResolvedValueOnce({ ok: false, skipped: true, reason: 'по заказу уже выписан УПД', orderId: 'o3' })

    const r = await executePendingAction('pa_1', 'u1')

    expect(mockApply).toHaveBeenNthCalledWith(1, { id: 'u1', role: 'ADMIN_PRO' }, {
      clientId: 'c',
      locationId: 'l',
      mealType: 'BREAKFAST',
      deliveryDate: new Date('2026-10-06T00:00:00.000Z'),
      portions: 9,
      source: 'BORIS',
      via: 'boris_period',
      pricePerPortion: 200,
    })
    expect(r.results).toEqual([
      { tool: 'upsert_order_portions', ok: true, error: undefined, data: { label: '06.10 завтрак — 9 (создан)' } },
      { tool: 'upsert_order_portions', ok: true, error: undefined, data: { label: '06.10 обед — 9 (подтверждён)' } },
      {
        tool: 'upsert_order_portions',
        ok: false,
        error: '06.10 ужин — 9: по заказу уже выписан УПД',
        data: undefined,
      },
    ])
  })
})
