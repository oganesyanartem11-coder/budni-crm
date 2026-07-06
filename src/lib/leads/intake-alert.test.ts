import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * ШАГ 1 — алёрты приёмника в чат «Директ от Бориса». Мокаем send + env;
 * проверяем [INTAKE]-пометку, мягкую деградацию без ENV и отсутствие throw.
 */

const { mockSend, mockReadDirectChatId } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockReadDirectChatId: vi.fn(),
}))

vi.mock('@/lib/telegram/send', () => ({ sendTelegramMessage: mockSend }))
vi.mock('@/lib/telegram/env', () => ({ readDirectChatId: mockReadDirectChatId }))

import { notifyIntakeAlert } from './intake-alert'

beforeEach(() => {
  vi.clearAllMocks()
  mockReadDirectChatId.mockReturnValue('-100500')
  mockSend.mockResolvedValue({ ok: true })
})

describe('notifyIntakeAlert', () => {
  it('шлёт в чат Директа с пометкой [INTAKE] и parseMode HTML', async () => {
    await notifyIntakeAlert('заявка потеряна')
    expect(mockSend).toHaveBeenCalledTimes(1)
    const [chatId, text, opts] = mockSend.mock.calls[0]
    expect(chatId).toBe('-100500')
    expect(text).toContain('[INTAKE]')
    expect(text).toContain('заявка потеряна')
    expect(opts).toEqual({ parseMode: 'HTML' })
  })

  it('ENV чата не задан (readDirectChatId кинул) → warn, не шлёт, не кидает', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockReadDirectChatId.mockImplementation(() => {
      throw new Error('no env')
    })
    await expect(notifyIntakeAlert('x')).resolves.toBeUndefined()
    expect(mockSend).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('send вернул ok:false → console.error, но не кидает', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSend.mockResolvedValue({ ok: false, error: 'forbidden' })
    await expect(notifyIntakeAlert('x')).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('send неожиданно кинул → двойная страховка, не всплывает в роут', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSend.mockRejectedValue(new Error('boom'))
    await expect(notifyIntakeAlert('x')).resolves.toBeUndefined()
    errSpy.mockRestore()
  })
})
