import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * TG-часть недельных заявок: форматтеры (итог по строкам / ручная проверка),
 * кнопки и callback scope 'wsub' (apply / reject / undo / legacy cancel).
 * escapeHtml реальный — проверяем экранирование динамики.
 */

const { mockPrisma, mockNotifyAllAdminProDirect, mockRegister, mockActions, mockSendBot, mockCreateInbox } = vi.hoisted(
  () => ({
    mockPrisma: {
      weeklyOrderSubmission: { update: vi.fn(), findUnique: vi.fn() },
      user: { findFirst: vi.fn() },
      client: { findUnique: vi.fn() },
    },
    mockNotifyAllAdminProDirect: vi.fn(),
    mockRegister: vi.fn(),
    mockActions: {
      applyReviewedSubmission: vi.fn(),
      cancelWeeklySubmission: vi.fn(),
      rejectWeeklySubmission: vi.fn(),
      undoWeeklyApply: vi.fn(),
    },
    mockSendBot: vi.fn(),
    mockCreateInbox: vi.fn(),
  }),
)

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../callback-router', () => ({ registerCallbackHandler: mockRegister }))
vi.mock('../notify', async () => {
  const actual = await vi.importActual<typeof import('../notify')>('../notify')
  return { ...actual, notifyAllAdminProDirect: mockNotifyAllAdminProDirect }
})
vi.mock('@/lib/weekly/actions', () => mockActions)
vi.mock('@/lib/bot/max-users', () => ({ getActiveMaxChatIdForClient: vi.fn(async () => 'max_chat_1') }))
vi.mock('@/lib/max/send-message', () => ({ sendBotMessage: mockSendBot }))
vi.mock('@/lib/bot/create-inbox-item', () => ({ createInboxItem: mockCreateInbox }))

import {
  formatAutoAppliedNotification,
  formatClientAppliedList,
  formatReviewNotification,
  notifyManagersWeeklyApplied,
  notifyManagersWeeklyReview,
} from './weekly-submission'
import type { WeeklyApplyResult } from '@/lib/weekly/actions'
import type { WeeklyLine } from '@/lib/weekly/sanity-checks'

// Транзитивные импорты регистрируют и другие scope — берём именно 'wsub'.
const handler = mockRegister.mock.calls.find((c) => c[0].scope === 'wsub')![0] as {
  scope: string
  handle: (ctx: unknown, action: string, id: string) => Promise<void>
}

const APPLIED: WeeklyApplyResult = {
  applyLogId: 'log_1',
  outcomes: [
    { date: '2026-10-05', locationName: 'Офис', portions: 30, result: 'created', note: null },
    { date: '2026-10-06', locationName: 'Офис', portions: 32, result: 'updated', note: null, prevPortions: 30 },
    { date: '2026-10-07', locationName: 'Офис', portions: 0, result: 'cancelled', note: null },
    { date: '2026-10-02', locationName: 'Офис', portions: 30, result: 'skipped', note: 'дата уже прошла' },
  ],
  menuMissingDates: ['2026-10-05'],
}

const LINE_BASE = {
  delta: null,
  prevPortions: null,
  deliveryDate: new Date('2026-10-06T00:00:00.000Z'),
  config: {
    configId: 'cfg_1',
    locationId: 'loc_1',
    locationName: 'Офис <1>',
    mealType: 'LUNCH' as const,
    pricePerPortion: 300,
    location: { sameDayDelivery: false, cutoffHourMsk: null, cutoffMinuteMsk: null },
  },
}

beforeEach(() => {
  mockNotifyAllAdminProDirect.mockReset().mockResolvedValue({ sentTo: 1 })
  mockPrisma.weeklyOrderSubmission.update.mockReset().mockResolvedValue({})
  mockPrisma.user.findFirst.mockReset().mockResolvedValue({ id: 'admin_pro_1', role: 'ADMIN_PRO' })
  mockPrisma.client.findUnique.mockReset().mockResolvedValue({ name: 'ХАЛВА' })
  Object.values(mockActions).forEach((f) => f.mockReset())
  mockSendBot.mockReset().mockResolvedValue(undefined)
  mockPrisma.weeklyOrderSubmission.findUnique.mockReset().mockResolvedValue({ client: { name: 'ХАЛВА' } })
})

describe('форматтеры', () => {
  it('автовнесение: коротко — «было → стало», невнесённое отдельно с причиной', () => {
    const text = formatAutoAppliedNotification('ООО <Ромашка>', APPLIED, { source: 'TEXT', rawText: 'пн 30, вт 32' })
    expect(text).toContain('✅ ООО &lt;Ромашка&gt;: внёс заявку')
    expect(text).toContain('💬 «пн 30, вт 32»')
    expect(text).toContain('• пн 5 окт — 30')
    expect(text).toContain('• вт 6 окт — 30 → 32')
    expect(text).toContain('• ср 7 окт — отменено')
    expect(text).toContain('Не внесено:\n• пт 2 окт — дата уже прошла')
    expect(text).toContain('ℹ️ Меню ещё не утверждено на: пн 5 окт')
  })

  it('ручная проверка (ИНПАРТ 06.10 «С 07 октября добавьте 1 полный обед»): коротко и понятно', () => {
    const lines: WeeklyLine[] = [
      { ...LINE_BASE, date: '2026-10-07', portions: 1, delta: 1, status: 'skip', note: 'приём на эту дату уже закрыт' },
      { ...LINE_BASE, date: '2026-10-08', portions: 35, delta: 1, prevPortions: 34, status: 'ok', note: null },
      { ...LINE_BASE, date: '2026-10-09', portions: 35, delta: 1, prevPortions: 34, status: 'ok', note: null },
    ]
    const text = formatReviewNotification({
      clientName: 'ООО "ИНПАРТ АВТО"',
      lines,
      reviewReasons: ['не уверен, что правильно понял сообщение'],
      source: 'TEXT',
      rawText: 'С 07 октября добавьте 1 полный обед',
      dietaryNotes: null,
    })
    expect(text).toBe(
      [
        '🔍 ООО "ИНПАРТ АВТО": проверьте заявку',
        '💬 «С 07 октября добавьте 1 полный обед»',
        '',
        'Если нажать «Внести»:',
        '• чт 8 окт — 34 → 35 (+1)',
        '• пт 9 окт — 34 → 35 (+1)',
        'Не внесётся:',
        '• ср 7 окт — приём на эту дату уже закрыт',
        '',
        'Почему не внёс сам: не уверен, что правильно понял сообщение',
      ].join('\n'),
    )
  })

  it('ручная проверка: невалидные строки и HTML экранированы', () => {
    const lines: WeeklyLine[] = [
      { ...LINE_BASE, date: '2026-10-06', portions: 30, status: 'ok', note: null },
      { ...LINE_BASE, date: '2026-10-07', portions: 0, status: 'ok', note: null },
      { date: '2026-02-30', deliveryDate: null, portions: 5, delta: null, prevPortions: null, status: 'blocked', note: 'непонятная дата «2026-02-30»', config: null },
    ]
    const text = formatReviewNotification({
      clientName: 'ХАЛВА',
      lines,
      reviewReasons: ['часть строк непонятна (отмечены ниже)'],
      source: 'TEXT',
      rawText: 'вт 30 <ср 0>',
      dietaryNotes: null,
    })
    expect(text).toContain('• вт 6 окт — 30')
    expect(text).toContain('• ср 7 окт — не нужно')
    expect(text).toContain('• 2026-02-30 — непонятная дата «2026-02-30»')
    expect(text).toContain('💬 «вт 30 &lt;ср 0&gt;»')
  })

  it('клиенту — только внесённое, без пропусков', () => {
    expect(formatClientAppliedList(APPLIED.outcomes)).toBe('пн 5 окт — 30, вт 6 окт — 32, ср 7 окт — не нужно')
  })
})

describe('уведомления менеджерам', () => {
  it('автовнесение — с кнопкой «↩️ Отменить» на конкретное применение', async () => {
    await notifyManagersWeeklyApplied({ submissionId: 'sub_1', clientName: 'ХАЛВА', applied: APPLIED })
    const opts = mockNotifyAllAdminProDirect.mock.calls[0][1]
    expect(JSON.stringify(opts.replyMarkup)).toContain('wsub:undo:log_1')
    expect(mockPrisma.weeklyOrderSubmission.update).toHaveBeenCalledWith({
      where: { id: 'sub_1' },
      data: { managerNotifiedAt: expect.any(Date) },
    })
  })

  it('Telegram не доставлен никому → managerNotifiedAt не ставим, InboxItem HIGH', async () => {
    mockNotifyAllAdminProDirect.mockResolvedValue({ sentTo: 0, skippedNoTelegram: 2, failed: 0 })
    mockPrisma.weeklyOrderSubmission.findUnique.mockResolvedValue({ clientId: 'client_1' })

    await notifyManagersWeeklyApplied({ submissionId: 'sub_1', clientName: 'ХАЛВА', applied: APPLIED })

    expect(mockPrisma.weeklyOrderSubmission.update).not.toHaveBeenCalled()
    expect(mockCreateInbox).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client_1', priority: 'HIGH' }),
    )
  })

  it('ручная проверка — кнопки «Внести» / «Не вносить»', async () => {
    await notifyManagersWeeklyReview({
      submissionId: 'sub_2',
      clientName: 'ХАЛВА',
      lines: [],
      reviewReasons: ['x'],
      source: 'PHOTO',
      blobUrl: 'https://blob/x.jpg',
      dietaryNotes: null,
    })
    const markup = JSON.stringify(mockNotifyAllAdminProDirect.mock.calls[0][1].replyMarkup)
    expect(markup).toContain('✅ Внести')
    expect(markup).toContain('wsub:apply:sub_2')
    expect(markup).toContain('wsub:reject:sub_2')
  })
})

describe("callback scope 'wsub'", () => {
  function makeCtx() {
    return { from: { id: 42 }, answerCallbackQuery: vi.fn(), editMessageText: vi.fn() }
  }

  it('зарегистрирован scope wsub', () => {
    expect(handler.scope).toBe('wsub')
  })

  it('не ADMIN_PRO → отказ, ничего не применяется', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null)
    const ctx = makeCtx()
    await handler.handle(ctx, 'apply', 'sub_1')
    expect(mockActions.applyReviewedSubmission).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Только для ADMIN_PRO', show_alert: true })
  })

  it('apply: вносит, показывает итог по строкам, даёт «Отменить», сообщает клиенту', async () => {
    mockActions.applyReviewedSubmission.mockResolvedValue({ ok: true, applied: APPLIED, clientId: 'client_1' })
    const ctx = makeCtx()

    await handler.handle(ctx, 'apply', 'sub_1')

    expect(mockActions.applyReviewedSubmission).toHaveBeenCalledWith({
      submissionId: 'sub_1',
      actor: { id: 'admin_pro_1', role: 'ADMIN_PRO' },
    })
    const [text, opts] = ctx.editMessageText.mock.calls[0]
    expect(text).toContain('✅ ХАЛВА: внесено')
    expect(text).toContain('• пт 2 окт — дата уже прошла')
    expect(JSON.stringify(opts.reply_markup)).toContain('wsub:undo:log_1')
    expect(text).toContain('Клиенту отправлено.')
    // Клиенту — без «живой» задержки 15–30 с: менеджер ждёт итог на кнопке.
    expect(mockSendBot).toHaveBeenCalledWith(
      'max_chat_1',
      'Заявку подтвердили: пн 5 окт — 30, вт 6 окт — 32, ср 7 окт — не нужно. ' +
        'Не смогли внести: пт 2 окт (дата уже прошла) — менеджер свяжется, если нужно.',
      { delay: false },
    )
    // Спиннер снят до отправки клиенту.
    expect(ctx.answerCallbackQuery.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendBot.mock.invocationCallOrder[0],
    )
  })

  it('apply: клиенту не ушло → в правке предупреждение, не «отправлено»', async () => {
    mockActions.applyReviewedSubmission.mockResolvedValue({ ok: true, applied: APPLIED, clientId: 'client_1' })
    mockSendBot.mockRejectedValue(new Error('max down'))
    const ctx = makeCtx()
    await handler.handle(ctx, 'apply', 'sub_1')
    const [text] = ctx.editMessageText.mock.calls[0]
    expect(text).not.toContain('Клиенту отправлено')
    expect(text).toContain('Клиенту не отправилось')
  })

  it('apply повторно → «Уже обработано»', async () => {
    mockActions.applyReviewedSubmission.mockResolvedValue({ ok: false, reason: 'already_processed' })
    const ctx = makeCtx()
    await handler.handle(ctx, 'apply', 'sub_1')
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Уже обработано', show_alert: true })
    expect(mockSendBot).not.toHaveBeenCalled()
  })

  it('reject → заявка отклонена', async () => {
    mockActions.rejectWeeklySubmission.mockResolvedValue({ ok: true })
    const ctx = makeCtx()
    await handler.handle(ctx, 'reject', 'sub_1')
    expect(ctx.editMessageText.mock.calls[0][0]).toBe('❌ ХАЛВА: заявка отклонена, заказы не вносились.')
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Отклонено' })
  })

  it('reject повторно → alert, сообщение с таблицей не затираем', async () => {
    mockActions.rejectWeeklySubmission.mockResolvedValue({ ok: false, keptPrevious: false })
    const ctx = makeCtx()
    await handler.handle(ctx, 'reject', 'sub_1')
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Уже обработано', show_alert: true })
    expect(ctx.editMessageText).not.toHaveBeenCalled()
  })

  it('undo → итог отката, неоткатанные с причиной', async () => {
    mockActions.undoWeeklyApply.mockResolvedValue({
      ok: true,
      submissionId: 'sub_1',
      results: [
        { orderId: 'o1', ok: true, note: null },
        { orderId: 'o2', ok: false, note: 'по заказу уже выписан УПД' },
      ],
    })
    const ctx = makeCtx()
    await handler.handle(ctx, 'undo', 'log_1')
    expect(mockActions.undoWeeklyApply).toHaveBeenCalledWith({
      applyLogId: 'log_1',
      actor: { id: 'admin_pro_1', role: 'ADMIN_PRO' },
    })
    const text = ctx.editMessageText.mock.calls[0][0]
    expect(text).toContain('↩️ ХАЛВА: внесение отменено: вернули 1 заказ(ов) к прежним значениям')
    expect(text).toContain('o2 (по заказу уже выписан УПД)')
  })

  it('legacy cancel со старых сообщений продолжает работать', async () => {
    mockActions.cancelWeeklySubmission.mockResolvedValue({ cancelled: 2, notCancelled: [] })
    const ctx = makeCtx()
    await handler.handle(ctx, 'cancel', 'sub_old')
    expect(mockActions.cancelWeeklySubmission).toHaveBeenCalledWith({
      submissionId: 'sub_old',
      cancelledById: 'admin_pro_1',
    })
    expect(ctx.editMessageText.mock.calls[0][0]).toContain('Откатили 2 заказов в DRAFT')
  })
})
