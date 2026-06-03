import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * MEGA weekly-order: тест чистого форматтера пуша о недельной заявке
 * (formatWeeklyNotification) — без вызовов Bot API.
 *
 * Мокаем @/lib/db/prisma и notify-функции, чтобы импорт модуля (который
 * за side-effect регистрирует callback-handler и тянет prisma/notify) не
 * требовал реального окружения. escapeHtml не мокаем — нужно его реальное
 * поведение для проверки экранирования динамики.
 */

const { mockPrisma, mockNotifyAllAdminProDirect } = vi.hoisted(() => ({
  mockPrisma: {
    weeklyOrderSubmission: { update: vi.fn() },
    user: { findFirst: vi.fn() },
  },
  mockNotifyAllAdminProDirect: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

vi.mock('../notify', async () => {
  const actual = await vi.importActual<typeof import('../notify')>('../notify')
  return {
    ...actual,
    notifyAllAdminProDirect: mockNotifyAllAdminProDirect,
  }
})

vi.mock('@/lib/weekly/actions', () => ({
  cancelWeeklySubmission: vi.fn(),
}))

// Импорт ПОСЛЕ vi.mock.
import {
  formatWeeklyNotification,
  notifyManagerAboutWeeklySubmission,
  type WeeklyNotificationParams,
} from './weekly-submission'

const BASE: WeeklyNotificationParams = {
  submissionId: 'sub_1',
  status: 'AUTO_CONFIRMED',
  clientName: 'ООО Ромашка',
  // 2026-06-01 = Пн, 2026-06-02 = Вт, 2026-06-03 = Ср
  items: [
    { date: '2026-06-01', portions: 20 },
    { date: '2026-06-02', portions: 18 },
  ],
  dietaryNotes: 'без свинины',
  confidence: 0.93,
  reason: '',
  source: 'PHOTO',
}

describe('formatWeeklyNotification', () => {
  it('AUTO_CONFIRMED: opening line, item-line format, notes, confidence 0.XX', () => {
    const text = formatWeeklyNotification(BASE)

    expect(text).toContain('✅ ООО Ромашка: заявка на след неделю принята.')
    // item-line: DD.MM (Пн) — N порций
    expect(text).toContain('01.06 (Пн) — 20 порций')
    expect(text).toContain('02.06 (Вт) — 18 порций')
    expect(text).toContain('Пометки: без свинины')
    expect(text).toContain('Источник: PHOTO, confidence 0.93')
    expect(text).toContain('Если что-то не так — нажми кнопку.')
  })

  it('AUTO_CONFIRMED: dietaryNotes null → «нет», confidence padded to 2 decimals', () => {
    const text = formatWeeklyNotification({
      ...BASE,
      dietaryNotes: null,
      confidence: 0.9,
    })
    expect(text).toContain('Пометки: нет')
    expect(text).toContain('confidence 0.90')
  })

  it('NEEDS_REVIEW: opening line, reason, draft lines, TEXT source with rawText', () => {
    const text = formatWeeklyNotification({
      ...BASE,
      status: 'NEEDS_REVIEW',
      reason: 'низкая уверенность',
      source: 'TEXT',
      rawText: 'пн 20 вт 18',
    })

    expect(text).toContain('🔍 ООО Ромашка: заявка получена, требует ручной проверки.')
    expect(text).toContain('Причина: низкая уверенность')
    expect(text).toContain('Распарсено (черновик):')
    expect(text).toContain('01.06 (Пн) — 20 (?)')
    expect(text).toContain('Источник: TEXT: пн 20 вт 18')
    expect(text).toContain('Создай заказы вручную через /orders/new если нужно.')
  })

  it('NEEDS_REVIEW: PHOTO source includes blobUrl', () => {
    const text = formatWeeklyNotification({
      ...BASE,
      status: 'NEEDS_REVIEW',
      reason: 'r',
      source: 'PHOTO',
      blobUrl: 'https://blob/x.jpg',
    })
    expect(text).toContain('Источник: PHOTO https://blob/x.jpg')
  })

  it('escapes HTML in dynamic substitutions (client name, notes)', () => {
    const text = formatWeeklyNotification({
      ...BASE,
      clientName: 'A & B <co>',
      dietaryNotes: 'no <peanuts> & nuts',
    })
    expect(text).toContain('A &amp; B &lt;co&gt;')
    expect(text).toContain('no &lt;peanuts&gt; &amp; nuts')
  })
})

describe('notifyManagerAboutWeeklySubmission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('AUTO_CONFIRMED: sends with cancel button and stamps managerNotifiedAt', async () => {
    await notifyManagerAboutWeeklySubmission(BASE)

    expect(mockNotifyAllAdminProDirect).toHaveBeenCalledTimes(1)
    const [text, opts] = mockNotifyAllAdminProDirect.mock.calls[0]
    expect(text).toContain('✅ ООО Ромашка: заявка на след неделю принята.')
    expect(opts?.replyMarkup).toBeDefined()

    expect(mockPrisma.weeklyOrderSubmission.update).toHaveBeenCalledWith({
      where: { id: 'sub_1' },
      data: { managerNotifiedAt: expect.any(Date) },
    })
  })

  it('NEEDS_REVIEW: sends without button', async () => {
    await notifyManagerAboutWeeklySubmission({
      ...BASE,
      status: 'NEEDS_REVIEW',
      reason: 'r',
      source: 'TEXT',
      rawText: 'x',
    })

    const [, opts] = mockNotifyAllAdminProDirect.mock.calls[0]
    expect(opts).toBeUndefined()
    expect(mockPrisma.weeklyOrderSubmission.update).toHaveBeenCalled()
  })
})
