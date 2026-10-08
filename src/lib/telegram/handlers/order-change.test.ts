import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Запросы клиента на изменение заказа (scope 'poc' / 'pocr'):
 *  - недоставка пуша менеджерам → InboxItem HIGH (не теряем запрос);
 *  - период → всегда InboxItem (NORMAL), как у однодневного;
 *  - callback: answerCallbackQuery ДО отправки клиенту, клиенту без задержки,
 *    правка сообщения сохраняет «кто/что», «Клиенту отправлено» — только по факту;
 *  - reason 'expired' — честно «ничего не применено».
 */

const { mockPrisma, mockRegister, mockNotifyAdminPro, mockActions, mockRange, mockSendBot, mockCreateInbox } =
  vi.hoisted(() => ({
    mockPrisma: {
      user: { findFirst: vi.fn() },
      pendingOrderChange: { findUnique: vi.fn() },
    },
    mockRegister: vi.fn(),
    mockNotifyAdminPro: vi.fn(),
    mockActions: { confirmPendingChange: vi.fn(), rejectPendingChange: vi.fn() },
    mockRange: { confirmRangeRequest: vi.fn(), rejectRangeRequest: vi.fn() },
    mockSendBot: vi.fn(),
    mockCreateInbox: vi.fn(),
  }))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../callback-router', () => ({ registerCallbackHandler: mockRegister }))
vi.mock('../notify', async () => {
  const actual = await vi.importActual<typeof import('../notify')>('../notify')
  return { ...actual, notifyAllAdminProDirect: mockNotifyAdminPro }
})
vi.mock('@/lib/order-changes/actions', () => mockActions)
vi.mock('@/lib/order-changes/range-request', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-changes/range-request')>(
    '@/lib/order-changes/range-request',
  )
  return { ...actual, ...mockRange }
})
vi.mock('@/lib/max/send-message', () => ({ sendBotMessage: mockSendBot }))
vi.mock('@/lib/bot/create-inbox-item', () => ({ createInboxItem: mockCreateInbox }))

import {
  notifyManagerAboutOrderChange,
  notifyManagerAboutRangeChange,
  ORDER_CHANGE_UNDELIVERED_REASON,
} from './order-change'

type Handler = { scope: string; handle: (ctx: unknown, action: string, id: string) => Promise<void> }
const handlers = new Map<string, Handler>(
  mockRegister.mock.calls.map((c) => [(c[0] as Handler).scope, c[0] as Handler]),
)
const poc = handlers.get('poc')!
const pocr = handlers.get('pocr')!

const NOTIFY = {
  changeId: 'chg_1',
  clientName: 'ХАЛВА',
  locationName: 'Офис',
  deliveryDate: new Date('2026-10-08T00:00:00.000Z'),
  mealType: 'LUNCH' as const,
  action: 'EDIT' as const,
  proposedPortions: 35,
  currentPortions: 34,
  rawClientMessage: 'на завтра 35',
  parsedConfidence: 0.9,
}

const PAYLOAD = {
  clientName: 'ИНПАРТ',
  rawText: 'с 8 по 14 +1 обед',
  sourceMaxChatId: 'max_1',
  request: {
    clientId: 'c1',
    locationId: 'loc_1',
    mealTypes: ['LUNCH' as const],
    dateFrom: '2026-10-08',
    dateTo: '2026-10-14',
    mode: 'add' as const,
    portions: 1,
  },
  plan: { lines: [], skipped: [], missingDates: [] },
}

function makeCtx() {
  const order: string[] = []
  const ctx = {
    from: { id: 42 },
    answerCallbackQuery: vi.fn(async (..._args: unknown[]) => {
      order.push('answer')
    }),
    editMessageText: vi.fn(async (..._args: unknown[]) => {
      order.push('edit')
    }),
  }
  mockSendBot.mockImplementation(async () => {
    order.push('send')
  })
  return { ctx, order }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin_1', role: 'ADMIN_PRO' })
  mockPrisma.pendingOrderChange.findUnique.mockResolvedValue({
    deliveryDate: new Date('2026-10-08T00:00:00.000Z'),
    mealType: 'LUNCH',
    client: { name: 'ХАЛВА' },
  })
  mockCreateInbox.mockResolvedValue({ id: 'inbox_1' })
})

describe('notifyManagerAboutOrderChange', () => {
  it('доставлено → без inbox', async () => {
    mockNotifyAdminPro.mockResolvedValue({ sentTo: 2, skippedNoTelegram: 0, failed: 0 })
    const r = await notifyManagerAboutOrderChange({ ...NOTIFY, clientId: 'c1' })
    expect(r).toEqual({ sentTo: 2, inboxItemId: null })
    expect(mockCreateInbox).not.toHaveBeenCalled()
  })

  it('sentTo=0 → InboxItem HIGH с clientId', async () => {
    mockNotifyAdminPro.mockResolvedValue({ sentTo: 0, skippedNoTelegram: 1, failed: 0 })
    const r = await notifyManagerAboutOrderChange({ ...NOTIFY, clientId: 'c1', conversationId: 'conv_1' })
    expect(r).toEqual({ sentTo: 0, inboxItemId: 'inbox_1' })
    expect(mockCreateInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'c1',
        conversationId: 'conv_1',
        reason: 'NON_NUMERIC',
        priority: 'HIGH',
        humanReason: expect.stringContaining(ORDER_CHANGE_UNDELIVERED_REASON),
      }),
    )
  })

  it('notify кинул → тоже считается недоставкой', async () => {
    mockNotifyAdminPro.mockRejectedValue(new Error('db down'))
    const r = await notifyManagerAboutOrderChange({ ...NOTIFY, clientId: 'c1' })
    expect(r.inboxItemId).toBe('inbox_1')
  })

  it('без clientId (старые вызовы) — inbox не создаётся, но и не падаем', async () => {
    mockNotifyAdminPro.mockResolvedValue({ sentTo: 0, skippedNoTelegram: 0, failed: 1 })
    const r = await notifyManagerAboutOrderChange(NOTIFY)
    expect(r).toEqual({ sentTo: 0, inboxItemId: null })
    expect(mockCreateInbox).not.toHaveBeenCalled()
  })
})

describe('notifyManagerAboutRangeChange', () => {
  it('доставлено + clientId → InboxItem NORMAL', async () => {
    mockNotifyAdminPro.mockResolvedValue({ sentTo: 1, skippedNoTelegram: 0, failed: 0 })
    const r = await notifyManagerAboutRangeChange({ requestId: 'req_1', payload: PAYLOAD, clientId: 'c1' })
    expect(r).toEqual({ sentTo: 1, inboxItemId: 'inbox_1' })
    expect(mockCreateInbox).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', priority: 'NORMAL', clientMessage: PAYLOAD.rawText }),
    )
  })

  it('не доставлено → один InboxItem HIGH', async () => {
    mockNotifyAdminPro.mockResolvedValue({ sentTo: 0, skippedNoTelegram: 0, failed: 2 })
    await notifyManagerAboutRangeChange({ requestId: 'req_1', payload: PAYLOAD, clientId: 'c1' })
    expect(mockCreateInbox).toHaveBeenCalledTimes(1)
    expect(mockCreateInbox.mock.calls[0][0]).toMatchObject({ priority: 'HIGH' })
  })

  it('без clientId — без inbox', async () => {
    mockNotifyAdminPro.mockResolvedValue({ sentTo: 1, skippedNoTelegram: 0, failed: 0 })
    await notifyManagerAboutRangeChange({ requestId: 'req_1', payload: PAYLOAD })
    expect(mockCreateInbox).not.toHaveBeenCalled()
  })
})

describe("callback 'poc'", () => {
  it('confirm: ответ на кнопку до отправки клиенту, без задержки, правка с клиентом/приёмом/датой', async () => {
    mockActions.confirmPendingChange.mockResolvedValue({
      ok: true,
      action: 'EDIT',
      orderId: 'o1',
      newPortions: 35,
      replyText: 'Обновили, теперь 35 порций на 08.10.',
      clientMaxChatId: '777',
    })
    const { ctx, order } = makeCtx()
    await poc.handle(ctx, 'confirm', 'chg_1')

    expect(order).toEqual(['answer', 'send', 'edit'])
    expect(mockSendBot).toHaveBeenCalledWith('777', 'Обновили, теперь 35 порций на 08.10.', { delay: false })
    expect(ctx.editMessageText).toHaveBeenCalledWith('✅ ХАЛВА: обед на 08.10 — 35 порций. Клиенту отправлено.')
  })

  it('confirm: отправка клиенту упала → не врём «отправлено»', async () => {
    mockActions.confirmPendingChange.mockResolvedValue({
      ok: true,
      action: 'CREATE',
      orderId: 'o1',
      newPortions: 10,
      replyText: 'x',
      clientMaxChatId: '777',
    })
    const { ctx } = makeCtx()
    mockSendBot.mockRejectedValue(new Error('max down'))
    await poc.handle(ctx, 'confirm', 'chg_1')
    const text = ctx.editMessageText.mock.calls[0][0] as string
    expect(text).toContain('ХАЛВА: обед на 08.10 — 10 порций')
    expect(text).not.toContain('Клиенту отправлено')
    expect(text).toContain('не отправилось')
  })

  it("expired → «истёк, ничего не применено», клиенту ничего не шлём", async () => {
    mockActions.confirmPendingChange.mockResolvedValue({ ok: false, reason: 'expired' })
    const { ctx } = makeCtx()
    await poc.handle(ctx, 'confirm', 'chg_1')
    const text = ctx.editMessageText.mock.calls[0][0] as string
    expect(text).toContain('ХАЛВА: обед на 08.10')
    expect(text).toContain('истёк')
    expect(text).toContain('ничего не применено')
    expect(mockSendBot).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Запрос истёк', show_alert: true })
  })

  it('reject: ответ на кнопку до отправки клиенту, без задержки', async () => {
    mockActions.rejectPendingChange.mockResolvedValue({
      ok: true,
      clientMaxChatId: '777',
      postCutoffReplyText: 'после 16:00…',
    })
    const { ctx, order } = makeCtx()
    await poc.handle(ctx, 'reject', 'chg_1')
    expect(order).toEqual(['answer', 'send', 'edit'])
    expect(mockSendBot).toHaveBeenCalledWith('777', 'после 16:00…', { delay: false })
    expect(ctx.editMessageText.mock.calls[0][0]).toContain('❌ ХАЛВА: обед на 08.10: отклонено')
  })

  it('не ADMIN_PRO → отказ', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null)
    const { ctx } = makeCtx()
    await poc.handle(ctx, 'confirm', 'chg_1')
    expect(mockActions.confirmPendingChange).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Только для админов', show_alert: true })
  })
})

describe("callback 'pocr'", () => {
  it('ok: ответ на кнопку первым, клиенту без задержки, в правке — статус отправки', async () => {
    mockRange.confirmRangeRequest.mockResolvedValue({
      ok: true,
      managerText: '✅ ИНПАРТ: изменено\n• чт 8 окт, обед — 35',
      clientReply: 'Обновили: чт 8 окт, обед — 35.',
      clientChatId: '777',
    })
    const { ctx, order } = makeCtx()
    await pocr.handle(ctx, 'ok', 'req_1')
    expect(order).toEqual(['answer', 'send', 'edit'])
    expect(mockSendBot).toHaveBeenCalledWith('777', 'Обновили: чт 8 окт, обед — 35.', { delay: false })
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      '✅ ИНПАРТ: изменено\n• чт 8 окт, обед — 35\nКлиенту отправлено.',
    )
  })

  it('уже обработано → alert, ничего не шлём', async () => {
    mockRange.rejectRangeRequest.mockResolvedValue({ ok: false, reason: 'already_processed' })
    const { ctx } = makeCtx()
    await pocr.handle(ctx, 'no', 'req_1')
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Уже обработано', show_alert: true })
    expect(mockSendBot).not.toHaveBeenCalled()
  })
})
