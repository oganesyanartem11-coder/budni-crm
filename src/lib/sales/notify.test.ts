import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InlineKeyboard } from 'grammy'

const { mockDirect, mockAllAdminPro } = vi.hoisted(() => ({
  mockDirect: vi.fn(),
  mockAllAdminPro: vi.fn(),
}))

vi.mock('@/lib/telegram/env', () => ({
  getTelegramEnv: () => ({ appBaseUrl: 'https://crm.test' }),
}))
vi.mock('@/lib/telegram/notify', () => ({
  notifyManagerDirect: mockDirect,
  notifyAllAdminProDirect: mockAllAdminPro,
  escapeHtml: (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}))

import {
  buildTaskDueText,
  leadButtons,
  nextStepKeyboard,
  notifyTaskDue,
  parseNextStepId,
  salesDoneData,
  salesNextData,
  salesSnoozeData,
  taskDueKeyboard,
} from './notify'

/** Prisma cuid() — 25 символов. */
const CUID = 'cmfz1a2b3c4d5e6f7g8h9i0jk'
const NOW = new Date('2026-09-24T09:00:00.000Z') // Чт 12:00 МСК

function callbackData(kb: InlineKeyboard): string[] {
  return kb.inline_keyboard
    .flat()
    .map((b) => ('callback_data' in b ? b.callback_data : null))
    .filter((d): d is string => typeof d === 'string')
}

function urls(kb: InlineKeyboard): string[] {
  return kb.inline_keyboard
    .flat()
    .map((b) => ('url' in b ? b.url : null))
    .filter((u): u is string => typeof u === 'string')
}

const task = {
  id: CUID,
  leadId: 'lead_1',
  type: 'CALL' as const,
  title: 'Связаться',
  note: null,
  dueAt: new Date('2026-09-24T08:55:00.000Z'),
  assigneeId: 'user_1',
}
const lead = { id: 'lead_1', company: null, name: 'Иван', phone: '+7 999 123-45-67' }

beforeEach(() => {
  vi.clearAllMocks()
  mockDirect.mockResolvedValue({ ok: true })
  mockAllAdminPro.mockResolvedValue({ sentTo: 1, skippedNoTelegram: 0, failed: 0 })
})

describe('callback_data — лимит Telegram 64 байта', () => {
  it('самый длинный вариант (next:<cuid>:write_3d) и done/snooze укладываются', () => {
    const all = [
      salesNextData(CUID, 'write_3d'),
      salesDoneData(CUID),
      salesSnoozeData(CUID),
      ...callbackData(nextStepKeyboard(CUID)),
      ...callbackData(taskDueKeyboard(CUID, CUID)),
      ...callbackData(leadButtons(CUID, CUID)),
    ]
    expect(salesNextData(CUID, 'write_3d')).toBe(`sales:next:${CUID}:write_3d`)
    for (const data of all) {
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
    }
  })
})

describe('parseNextStepId', () => {
  it('разбирает cuid-лид и каждый слот', () => {
    expect(parseNextStepId(`${CUID}:call_t10`)).toEqual({ leadId: CUID, slot: 'call_t10' })
    expect(parseNextStepId(`${CUID}:write_3d`)).toEqual({ leadId: CUID, slot: 'write_3d' })
    expect(parseNextStepId(`${CUID}:kp_t10`)).toEqual({ leadId: CUID, slot: 'kp_t10' })
    expect(parseNextStepId(`${CUID}:none`)).toEqual({ leadId: CUID, slot: 'none' })
  })

  it('делит по последнему двоеточию', () => {
    expect(parseNextStepId('a:b:none')).toEqual({ leadId: 'a:b', slot: 'none' })
  })

  it.each(['', 'abc', ':call_t10', `${CUID}:`, `${CUID}:tomorrow`, `${CUID}:call_t10:x`, `${CUID}`])(
    'битый вход %j → null',
    (input) => {
      expect(parseNextStepId(input)).toBeNull()
    }
  )
})

describe('taskDueKeyboard', () => {
  it('Сделано / +1 день / Открыть', () => {
    const kb = taskDueKeyboard('task_1', 'lead_1')
    const texts = kb.inline_keyboard.flat().map((b) => b.text)
    expect(texts).toEqual(['✅ Сделано', '⏰ +1 день', 'Открыть'])
    expect(callbackData(kb)).toEqual(['sales:done:task_1', 'sales:snooze:task_1'])
    expect(urls(kb)).toEqual(['https://crm.test/sales/lead_1'])
  })
})

describe('buildTaskDueText', () => {
  it('экранирует пользовательские поля', () => {
    const text = buildTaskDueText(
      { type: 'CALL', title: 'Уточнить <меню> & цены', note: 'Звонить после 14:00 <срочно>', dueAt: NOW },
      { company: null, name: '<script>alert(1)</script> & Co', phone: '+7 <999>' },
      NOW
    )
    expect(text).not.toContain('<script>')
    expect(text).toContain('⏰ Позвонить: <b>&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co</b>')
    expect(text).toContain('📞 <code>+7 &lt;999&gt;</code>')
    expect(text).toContain('📌 Уточнить &lt;меню&gt; &amp; цены')
    expect(text).toContain('📝 Звонить после 14:00 &lt;срочно&gt;')
  })

  it('компания важнее имени; «Связаться» и совпадающий с типом title не дублируются', () => {
    const auto = buildTaskDueText({ type: 'CALL', title: 'Связаться', note: null, dueAt: NOW }, { ...lead, company: 'ООО Ромашка' }, NOW)
    expect(auto).toBe('⏰ Позвонить: <b>ООО Ромашка</b>\n📞 <code>+7 999 123-45-67</code>')

    const same = buildTaskDueText({ type: 'SEND_PROPOSAL', title: 'Отправить КП', note: '  ', dueAt: NOW }, lead, NOW)
    expect(same).toBe('⏰ Отправить КП: <b>Иван</b>\n📞 <code>+7 999 123-45-67</code>')
  })

  it.each([
    [20, null],
    [30, null],
    [45, '⚠️ просрочено на 45 мин'],
    [3 * 60 + 10, '⚠️ просрочено на 3 ч'],
    [23 * 60 + 59, '⚠️ просрочено на 23 ч'],
    [2 * 24 * 60 + 5, '⚠️ просрочено на 2 дн'],
  ])('просрочка %i мин → %j', (minutes, expected) => {
    const dueAt = new Date(NOW.getTime() - minutes * 60_000)
    const text = buildTaskDueText({ type: 'CALL', title: 'Связаться', note: null, dueAt }, lead, NOW)
    if (expected) expect(text.split('\n').at(-1)).toBe(expected)
    else expect(text).not.toContain('просрочено')
  })
})

describe('notifyTaskDue', () => {
  it('исполнителю в личку с кнопками; ADMIN_PRO не трогаем', async () => {
    const res = await notifyTaskDue(task, lead, NOW)

    expect(res).toEqual({ delivered: true, skipped: false })
    expect(mockDirect).toHaveBeenCalledTimes(1)
    const [userId, text, opts] = mockDirect.mock.calls[0]
    expect(userId).toBe('user_1')
    expect(text).toContain('⏰ Позвонить: <b>Иван</b>')
    expect(callbackData(opts.replyMarkup)).toEqual([`sales:done:${CUID}`, `sales:snooze:${CUID}`])
    expect(mockAllAdminPro).not.toHaveBeenCalled()
  })

  it('у исполнителя нет Telegram (skipped) → фолбэк всем ADMIN_PRO', async () => {
    mockDirect.mockResolvedValue({ ok: false, skipped: true, error: 'no_telegram_chat_id' })

    const res = await notifyTaskDue(task, lead, NOW)

    expect(res).toEqual({ delivered: true, skipped: false })
    expect(mockAllAdminPro).toHaveBeenCalledTimes(1)
    expect(callbackData(mockAllAdminPro.mock.calls[0][1].replyMarkup)).toContain(`sales:done:${CUID}`)
  })

  it('без исполнителя → сразу ADMIN_PRO', async () => {
    const res = await notifyTaskDue({ ...task, assigneeId: null }, lead, NOW)

    expect(res).toEqual({ delivered: true, skipped: false })
    expect(mockDirect).not.toHaveBeenCalled()
    expect(mockAllAdminPro).toHaveBeenCalledTimes(1)
  })

  it('некому доставить → skipped', async () => {
    mockDirect.mockResolvedValue({ ok: false, skipped: true, error: 'no_telegram_chat_id' })
    mockAllAdminPro.mockResolvedValue({ sentTo: 0, skippedNoTelegram: 2, failed: 0 })

    expect(await notifyTaskDue(task, lead, NOW)).toEqual({ delivered: false, skipped: true })
  })

  it('ошибка API у исполнителя → фолбэк ADMIN_PRO; всё упало → error, не skipped', async () => {
    mockDirect.mockResolvedValue({ ok: false, error: 'Forbidden: bot was blocked by the user' })
    const partial = await notifyTaskDue(task, lead, NOW)
    expect(partial.delivered).toBe(true)
    expect(partial.error).toContain('bot was blocked')

    mockAllAdminPro.mockResolvedValue({ sentTo: 0, skippedNoTelegram: 0, failed: 1 })
    const failed = await notifyTaskDue(task, lead, NOW)
    expect(failed.delivered).toBe(false)
    expect(failed.skipped).toBe(false)
    expect(failed.error).toContain('admin_pro_failed: 1')
  })

  it('не бросает при исключении', async () => {
    mockDirect.mockRejectedValue(new Error('db down'))

    await expect(notifyTaskDue(task, lead, NOW)).resolves.toEqual({
      delivered: false,
      skipped: false,
      error: 'db down',
    })
  })
})
