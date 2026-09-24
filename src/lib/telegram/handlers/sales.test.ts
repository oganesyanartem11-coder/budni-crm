import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, InlineKeyboard } from 'grammy'

const {
  mockRegister,
  mockIdentify,
  mockComplete,
  mockChangeStatus,
  mockCreateTask,
  mockReschedule,
  mockTaskFindUnique,
  mockTaskCount,
  mockTrackError,
} = vi.hoisted(() => ({
  mockRegister: vi.fn(),
  mockIdentify: vi.fn(),
  mockComplete: vi.fn(),
  mockChangeStatus: vi.fn(),
  mockCreateTask: vi.fn(),
  mockReschedule: vi.fn(),
  mockTaskFindUnique: vi.fn(),
  mockTaskCount: vi.fn(),
  mockTrackError: vi.fn(),
}))

vi.mock('../callback-router', () => ({ registerCallbackHandler: mockRegister }))
vi.mock('../identify-user', () => ({ identifyTelegramUser: mockIdentify }))
vi.mock('@/lib/sales/core', () => ({
  completeTaskCore: mockComplete,
  changeLeadStatusCore: mockChangeStatus,
  createTaskCore: mockCreateTask,
  rescheduleTaskCore: mockReschedule,
}))
vi.mock('@/lib/db/prisma', () => ({
  prisma: { salesTask: { findUnique: mockTaskFindUnique, count: mockTaskCount } },
}))
vi.mock('@/lib/errors/tracker', () => ({ trackError: mockTrackError }))
vi.mock('@/lib/telegram/env', () => ({
  getTelegramEnv: () => ({ appBaseUrl: 'https://crm.test' }),
}))
vi.mock('@/lib/telegram/notify', () => ({
  notifyManagerDirect: vi.fn(),
  notifyAllAdminProDirect: vi.fn(),
  escapeHtml: (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}))

import { handleSalesCallback } from './sales'

const registered = mockRegister.mock.calls[0]?.[0] as
  | { scope: string; handle: (ctx: Context, action: string, id: string) => Promise<void> }
  | undefined

/** Prisma cuid() — 25 символов. */
const LEAD_ID = 'cmfz1a2b3c4d5e6f7g8h9i0jk'
const TASK_ID = 'cmfz9z8y7x6w5v4u3t2s1r0qp'
const NOW = new Date('2026-09-24T09:00:00.000Z') // Чт 12:00 МСК

const admin = { id: 'user_1', name: 'Артём <Pro>', role: 'ADMIN_PRO' as const, isActive: true }

function makeCtx(chatType: 'private' | 'supergroup' = 'private') {
  return {
    from: { id: 42 },
    chat: { id: chatType === 'private' ? 42 : -100500, type: chatType },
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    reply: vi.fn().mockResolvedValue({}),
  }
}
type Ctx = ReturnType<typeof makeCtx>
const asCtx = (ctx: Ctx) => ctx as unknown as Context

function callbackData(kb: InlineKeyboard): string[] {
  return kb.inline_keyboard
    .flat()
    .map((b) => ('callback_data' in b ? b.callback_data : null))
    .filter((d): d is string => typeof d === 'string')
}

function completed(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      leadId: LEAD_ID,
      leadLabel: 'ООО «Ромашка» & Co',
      task: { id: TASK_ID, type: 'CALL', title: 'Связаться' },
      alreadyDone: false,
      hasOtherOpenTasks: false,
      otherOpenTasksCount: 0,
      suggestedStatus: null,
      ...over,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIdentify.mockResolvedValue(admin)
  mockComplete.mockResolvedValue(completed())
  mockChangeStatus.mockResolvedValue({ ok: true, data: { status: 'IN_PROGRESS', changed: true } })
  mockCreateTask.mockImplementation(async (_actor, input: { leadId: string; dueAt: Date }) => ({
    ok: true,
    data: { taskId: 'task_new', leadId: input.leadId, dueAt: input.dueAt, deduplicated: false },
  }))
  mockTaskCount.mockResolvedValue(0)
})

describe('регистрация', () => {
  it('scope sales регистрируется при импорте', () => {
    expect(registered?.scope).toBe('sales')
  })
})

describe('доступ', () => {
  it('не нашли юзера → «Не нашёл тебя», Core не зовём', async () => {
    mockIdentify.mockResolvedValue(null)
    const ctx = makeCtx()

    await handleSalesCallback(asCtx(ctx), 'done', TASK_ID, NOW)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Не нашёл тебя' }))
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it.each(['ADMIN', 'MANAGER', 'CHEF'] as const)('%s (не SALES_ROLES) → «Нет доступа»', async (role) => {
    mockIdentify.mockResolvedValue({ ...admin, role })
    const ctx = makeCtx()

    await handleSalesCallback(asCtx(ctx), 'next', `${LEAD_ID}:call_t10`, NOW)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Нет доступа' }))
    expect(mockCreateTask).not.toHaveBeenCalled()
    expect(ctx.editMessageText).not.toHaveBeenCalled()
  })
})

describe('done', () => {
  it('уже сделано → «Уже сделано», сообщение не трогаем', async () => {
    mockComplete.mockResolvedValue(completed({ alreadyDone: true }))
    const ctx = makeCtx()

    await handleSalesCallback(asCtx(ctx), 'done', TASK_ID, NOW)

    expect(mockComplete).toHaveBeenCalledWith({ id: 'user_1', role: 'ADMIN_PRO' }, TASK_ID)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Уже сделано' }))
    expect(ctx.editMessageText).not.toHaveBeenCalled()
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(mockChangeStatus).not.toHaveBeenCalled()
  })

  it('личка: применяет suggestedStatus, заменяет напоминание итогом и спрашивает «Что дальше?»', async () => {
    mockComplete.mockResolvedValue(completed({ suggestedStatus: 'IN_PROGRESS' }))
    const ctx = makeCtx('private')

    await handleSalesCallback(asCtx(ctx), 'done', TASK_ID, NOW)

    expect(mockChangeStatus).toHaveBeenCalledWith(
      { id: 'user_1', role: 'ADMIN_PRO' },
      { leadId: LEAD_ID, status: 'IN_PROGRESS' }
    )
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      '✅ Сделано: Связаться — <b>ООО «Ромашка» &amp; Co</b>\nСтадия → В работе',
      { parse_mode: 'HTML' }
    )
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled()

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const [text, opts] = ctx.reply.mock.calls[0]
    expect(text).toBe('Что дальше по <b>ООО «Ромашка» &amp; Co</b>?')
    expect(opts.parse_mode).toBe('HTML')
    expect(callbackData(opts.reply_markup)).toEqual([
      `sales:next:${LEAD_ID}:call_t10`,
      `sales:next:${LEAD_ID}:write_3d`,
      `sales:next:${LEAD_ID}:kp_t10`,
      `sales:next:${LEAD_ID}:none`,
    ])
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Готово' }))
  })

  it('чат заявок: текст заявки не затираем — снимаем кнопку задачи и пишем отдельным сообщением', async () => {
    const ctx = makeCtx('supergroup')

    await handleSalesCallback(asCtx(ctx), 'done', TASK_ID, NOW)

    expect(mockChangeStatus).not.toHaveBeenCalled()
    expect(ctx.editMessageText).not.toHaveBeenCalled()
    const markup = ctx.editMessageReplyMarkup.mock.calls[0][0].reply_markup as InlineKeyboard
    expect(callbackData(markup)).toEqual([]) // только [Открыть заявку]
    expect(markup.inline_keyboard.flat().map((b) => b.text)).toEqual(['Открыть заявку'])

    expect(ctx.reply).toHaveBeenCalledTimes(2)
    expect(ctx.reply.mock.calls[0][0]).toBe('✅ Артём &lt;Pro&gt;: Связаться — <b>ООО «Ромашка» &amp; Co</b>')
    expect(ctx.reply.mock.calls[1][0]).toContain('Что дальше по')
  })

  it('ошибка editMessage* не делает действие проваленным', async () => {
    const ctx = makeCtx('private')
    ctx.editMessageText.mockRejectedValue(new Error('Bad Request: message is not modified'))

    await handleSalesCallback(asCtx(ctx), 'done', TASK_ID, NOW)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Готово' }))
    expect(mockTrackError).not.toHaveBeenCalled()
  })

  it('ошибка Core → «Не получилось, попробуй в CRM» без throw + trackError', async () => {
    mockComplete.mockRejectedValue(new Error('P2024 pool timeout'))
    const ctx = makeCtx()

    await expect(handleSalesCallback(asCtx(ctx), 'done', TASK_ID, NOW)).resolves.toBeUndefined()

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Не получилось, попробуй в CRM' })
    )
    expect(mockTrackError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', extra: { scope: 'sales', action: 'done', id: TASK_ID } })
    )
  })

  it('Core вернул ok:false → текст ошибки в ответ, без правок сообщения', async () => {
    mockComplete.mockResolvedValue({ ok: false, error: 'Задача не найдена' })
    const ctx = makeCtx()

    await handleSalesCallback(asCtx(ctx), 'done', TASK_ID, NOW)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Задача не найдена' }))
    expect(ctx.editMessageText).not.toHaveBeenCalled()
  })
})

describe('snooze', () => {
  it('просроченную на дни двигает на тот же час МСК, но в будущее', async () => {
    // 20.09 09:30 МСК, сейчас 24.09 12:00 МСК → 25.09 09:30 МСК
    mockTaskFindUnique.mockResolvedValue({
      dueAt: new Date('2026-09-20T06:30:00.000Z'),
      doneAt: null,
      lead: { company: null, name: 'Иван', phone: '+7 999' },
    })
    mockReschedule.mockImplementation(async (_actor, input: { dueAt: Date }) => ({
      ok: true,
      data: { leadId: LEAD_ID, title: 'Связаться', dueAt: input.dueAt },
    }))
    const ctx = makeCtx()

    await handleSalesCallback(asCtx(ctx), 'snooze', TASK_ID, NOW)

    expect(mockReschedule).toHaveBeenCalledWith(
      { id: 'user_1', role: 'ADMIN_PRO' },
      { taskId: TASK_ID, dueAt: new Date('2026-09-25T06:30:00.000Z') }
    )
    const [text, opts] = ctx.editMessageText.mock.calls[0]
    expect(text).toMatch(/^⏰ Перенёс: Связаться — <b>Иван<\/b>\n🗓 .*09:30$/)
    expect(opts).toEqual({ parse_mode: 'HTML' })
  })

  it('закрытая задача → «Задача уже закрыта»', async () => {
    mockTaskFindUnique.mockResolvedValue({ dueAt: NOW, doneAt: NOW, lead: { company: null, name: null, phone: '1' } })
    const ctx = makeCtx()

    await handleSalesCallback(asCtx(ctx), 'snooze', TASK_ID, NOW)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Задача уже закрыта' }))
    expect(mockReschedule).not.toHaveBeenCalled()
  })

  it('срок уже в будущем (перенёс кто-то другой) → повторно не двигаем', async () => {
    mockTaskFindUnique.mockResolvedValue({
      dueAt: new Date('2026-09-25T06:30:00.000Z'),
      doneAt: null,
      lead: { company: null, name: 'Иван', phone: '+7 999' },
    })
    const ctx = makeCtx()

    await handleSalesCallback(asCtx(ctx), 'snooze', TASK_ID, NOW)

    expect(mockReschedule).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Уже перенесено' }))
  })
})

describe('next', () => {
  it.each([
    ['call_t10', 'CALL', '2026-09-25T07:00:00.000Z', 'Позвонить'],
    ['write_3d', 'WRITE', '2026-09-27T07:00:00.000Z', 'Написать'],
    ['kp_t10', 'SEND_PROPOSAL', '2026-09-25T07:00:00.000Z', 'Отправить КП'],
  ] as const)('%s → задача %s на %s', async (slot, type, dueIso, typeRu) => {
    const ctx = makeCtx()

    await handleSalesCallback(asCtx(ctx), 'next', `${LEAD_ID}:${slot}`, NOW)

    expect(mockCreateTask).toHaveBeenCalledWith(
      { id: 'user_1', role: 'ADMIN_PRO' },
      { leadId: LEAD_ID, type, dueAt: new Date(dueIso) }
    )
    const [text] = ctx.editMessageText.mock.calls[0]
    expect(text).toMatch(new RegExp(`^📌 Следующий шаг: ${typeRu} — .* 10:00$`))
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Записал' }))
  })

  it('через зарегистрированный handle: берёт текущее время (vi.setSystemTime)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      const ctx = makeCtx()
      await registered!.handle(asCtx(ctx), 'next', `${LEAD_ID}:call_t10`)
      expect(mockCreateTask.mock.calls[0][1].dueAt).toEqual(new Date('2026-09-25T07:00:00.000Z'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('none без открытых задач → пометка ⚠️, задачу не создаём', async () => {
    const ctx = makeCtx()

    await handleSalesCallback(asCtx(ctx), 'next', `${LEAD_ID}:none`, NOW)

    expect(mockCreateTask).not.toHaveBeenCalled()
    expect(mockTaskCount).toHaveBeenCalledWith({ where: { leadId: LEAD_ID, doneAt: null } })
    expect(ctx.editMessageText).toHaveBeenCalledWith('Ок, без следующего шага. В CRM заявка помечена ⚠️', {
      parse_mode: 'HTML',
    })
  })

  it('битый id → «Неизвестное действие»', async () => {
    const ctx = makeCtx()

    await handleSalesCallback(asCtx(ctx), 'next', `${LEAD_ID}:tomorrow`, NOW)

    expect(mockCreateTask).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Неизвестное действие' }))
  })

  it('неизвестный action → «Неизвестное действие»', async () => {
    const ctx = makeCtx()

    await handleSalesCallback(asCtx(ctx), 'explode', TASK_ID, NOW)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Неизвестное действие' }))
  })
})
