import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockRegister,
  mockIdentify,
  mockConfirm,
  mockReject,
  mockNotifyManagers,
} = vi.hoisted(() => ({
  mockRegister: vi.fn(),
  mockIdentify: vi.fn(),
  mockConfirm: vi.fn(),
  mockReject: vi.fn(),
  mockNotifyManagers: vi.fn(),
}))

vi.mock('../callback-router', () => ({ registerCallbackHandler: mockRegister }))
vi.mock('../identify-user', () => ({ identifyTelegramUser: mockIdentify }))
vi.mock('@/lib/orders/anomaly-confirmations', () => ({
  confirmPendingAnomaly: mockConfirm,
  rejectPendingAnomaly: mockReject,
}))
vi.mock('../notify', async () => {
  const actual = await vi.importActual<typeof import('../notify')>('../notify')
  return { ...actual, notifyAllManagersDirect: mockNotifyManagers }
})

import { anomalyConfirmationButtons } from '../buttons'
import {
  formatAnomalyNotification,
  handleAnomalyConfirmationCallback,
  notifyManagersAboutAnomaly,
} from './anomaly-confirmation'

const notification = {
  confirmationId: 'anom_1',
  clientName: 'Клиент <важный>',
  locationName: 'Офис & склад',
  deliveryDate: new Date('2026-08-07T00:00:00.000Z'),
  mealType: 'LUNCH' as const,
  proposedPortions: 5,
  comparisonSource: 'baseline' as const,
  expected: { min: 15, max: 60, average: 30, samples: 1 },
  reason: 'below_threshold' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockNotifyManagers.mockResolvedValue({ sentTo: 2, skippedNoTelegram: 0, failed: 0 })
  mockConfirm.mockResolvedValue({ ok: true, orderId: 'order_1', portions: 5 })
  mockReject.mockResolvedValue({ ok: true, inboxItemId: 'inbox_1' })
})

describe('anomaly notification', () => {
  it('экранирует пользовательский HTML и объясняет baseline/причину', () => {
    const text = formatAnomalyNotification(notification)

    expect(text).toContain('Клиент &lt;важный&gt;')
    expect(text).toContain('Офис &amp; склад')
    expect(text).toContain('07.08')
    expect(text).toContain('5 порций')
    expect(text).toContain('подтверждённый уровень: 30')
    expect(text).toContain('ниже допустимого коридора 15–60')
    expect(text).toContain('Всё ок?')
  })

  it('отправляет ADMIN/ADMIN_PRO/MANAGER кнопки отдельного scope anom', async () => {
    await notifyManagersAboutAnomaly(notification)

    const [, options] = mockNotifyManagers.mock.calls[0]
    expect(options.parseMode).toBe('HTML')
    expect(JSON.stringify(options.replyMarkup)).toContain('anom:ok:anom_1')
    expect(JSON.stringify(options.replyMarkup)).toContain('anom:no:anom_1')
  })

  it('sentTo=0 считается невозможностью доставки', async () => {
    mockNotifyManagers.mockResolvedValue({ sentTo: 0, skippedNoTelegram: 3, failed: 0 })
    await expect(notifyManagersAboutAnomaly(notification)).rejects.toThrow('не доставлено')
  })

  it('кнопки имеют точные callback_data', () => {
    const serialized = JSON.stringify(anomalyConfirmationButtons('anom_1'))
    expect(serialized).toContain('✅ Да')
    expect(serialized).toContain('anom:ok:anom_1')
    expect(serialized).toContain('❌ Нет')
    expect(serialized).toContain('anom:no:anom_1')
  })
})

describe('handleAnomalyConfirmationCallback — роли и идемпотентность', () => {
  function makeCtx() {
    return {
      from: { id: 123 },
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
    } as never
  }

  it.each(['ADMIN', 'ADMIN_PRO', 'MANAGER'] as const)('%s может подтвердить', async (role) => {
    mockIdentify.mockResolvedValue({ id: `user_${role}`, name: role, role, isActive: true })
    const ctx = makeCtx()

    await handleAnomalyConfirmationCallback(ctx, 'ok', 'anom_1')

    expect(mockConfirm).toHaveBeenCalledWith({
      confirmationId: 'anom_1',
      user: { id: `user_${role}`, role },
    })
    expect((ctx as { editMessageText: ReturnType<typeof vi.fn> }).editMessageText)
      .toHaveBeenCalledWith('✅ Заказ создан, уровень обновлён: 5 порций')
  })

  it.each(['CHEF', 'COURIER'] as const)('%s не может подтвердить', async (role) => {
    mockIdentify.mockResolvedValue({ id: `user_${role}`, name: role, role, isActive: true })
    const ctx = makeCtx()

    await handleAnomalyConfirmationCallback(ctx, 'ok', 'anom_1')

    expect(mockConfirm).not.toHaveBeenCalled()
    expect((ctx as { answerCallbackQuery: ReturnType<typeof vi.fn> }).answerCallbackQuery)
      .toHaveBeenCalledWith({ text: 'Нет прав для подтверждения', show_alert: true })
  })

  it('повторный ok показывает «Уже обработано»', async () => {
    mockIdentify.mockResolvedValue({ id: 'manager_1', role: 'MANAGER', isActive: true })
    mockConfirm.mockResolvedValue({ ok: false, reason: 'already_processed' })
    const ctx = makeCtx()

    await handleAnomalyConfirmationCallback(ctx, 'ok', 'anom_1')

    expect((ctx as { editMessageText: ReturnType<typeof vi.fn> }).editMessageText)
      .toHaveBeenCalledWith('Уже обработано')
  })

  it('параллельный ok показывает «Уже обрабатывается»', async () => {
    mockIdentify.mockResolvedValue({ id: 'manager_1', role: 'MANAGER', isActive: true })
    mockConfirm.mockResolvedValue({ ok: false, reason: 'already_processing' })
    const ctx = makeCtx()

    await handleAnomalyConfirmationCallback(ctx, 'ok', 'anom_1')

    expect((ctx as { editMessageText: ReturnType<typeof vi.fn> }).editMessageText)
      .toHaveBeenCalledWith('Уже обрабатывается')
  })

  it('recovery честно сообщает о восстановленной операции', async () => {
    mockIdentify.mockResolvedValue({ id: 'admin_1', role: 'ADMIN', isActive: true })
    mockConfirm.mockResolvedValue({
      ok: true,
      orderId: 'order_existing',
      portions: 5,
      recovered: true,
    })
    const ctx = makeCtx()

    await handleAnomalyConfirmationCallback(ctx, 'ok', 'anom_1')

    expect((ctx as { editMessageText: ReturnType<typeof vi.fn> }).editMessageText)
      .toHaveBeenCalledWith('✅ Операция восстановлена: заказ уже создан, уровень обновлён: 5 порций')
  })

  it('частичный успех показывает точное предупреждение о baseline', async () => {
    mockIdentify.mockResolvedValue({ id: 'manager_1', role: 'MANAGER', isActive: true })
    mockConfirm.mockResolvedValue({
      ok: false,
      reason: 'baseline_error',
      error: 'database unavailable',
      orderId: 'order_1',
    })
    const ctx = makeCtx()

    await handleAnomalyConfirmationCallback(ctx, 'ok', 'anom_1')

    expect((ctx as { editMessageText: ReturnType<typeof vi.fn> }).editMessageText)
      .toHaveBeenCalledWith('Заказ создан, но уровень не обновлён — проверьте baseline')
  })

  it('no отклоняет и отправляет в inbox', async () => {
    mockIdentify.mockResolvedValue({ id: 'manager_1', role: 'MANAGER', isActive: true })
    const ctx = makeCtx()

    await handleAnomalyConfirmationCallback(ctx, 'no', 'anom_1')

    expect(mockReject).toHaveBeenCalledWith({ confirmationId: 'anom_1', userId: 'manager_1' })
    expect((ctx as { editMessageText: ReturnType<typeof vi.fn> }).editMessageText)
      .toHaveBeenCalledWith('Отклонено, ушло в inbox')
  })
})
