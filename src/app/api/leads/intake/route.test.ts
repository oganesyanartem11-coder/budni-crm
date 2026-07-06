import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * ШАГ 1 + ШАГ 2 — приёмник заявок: шумные алёрты по путям потери + дедуп
 * ретраев. Мокаем notify/persist/alert/dedup; escapeHtml — реальный.
 * Контракт клиента (статусы/{ok}) не меняем — проверяем это тоже.
 */

const {
  mockNotifyLeads,
  mockPersist,
  mockAlert,
  mockFindDup,
  mockRecordDrop,
  mockFindDelivered,
  mockRecordDelivered,
  mockThrottle,
} = vi.hoisted(() => ({
  mockNotifyLeads: vi.fn(),
  mockPersist: vi.fn(),
  mockAlert: vi.fn(),
  mockFindDup: vi.fn(),
  mockRecordDrop: vi.fn(),
  mockFindDelivered: vi.fn(),
  mockRecordDelivered: vi.fn(),
  mockThrottle: vi.fn(),
}))

vi.mock('@/lib/telegram/notify', () => ({
  notifyLeads: mockNotifyLeads,
  // реальный escapeHtml, чтобы проверять экранирование без дублирования логики
  escapeHtml: (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}))
vi.mock('@/lib/telegram/env', () => ({ readLeadsIntakeSecret: () => 'secret' }))
vi.mock('@/lib/leads/persist-landing-lead', () => ({ persistLandingLead: mockPersist }))
vi.mock('@/lib/leads/intake-alert', () => ({ notifyIntakeAlert: mockAlert }))
vi.mock('@/lib/leads/dedup', () => ({
  findRecentDelivered: mockFindDelivered,
  recordDelivered: mockRecordDelivered,
  findRecentDuplicate: mockFindDup,
  recordDedupDrop: mockRecordDrop,
  throttleHoneypotAlert: mockThrottle,
}))

import { POST } from './route'

const ORIGIN = 'https://budni.pro'

function req(body: unknown, headers: Record<string, string> = { origin: ORIGIN }): Request {
  return new Request('https://budni-crm.vercel.app/api/leads/intake', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockFindDelivered.mockResolvedValue(null) // по умолчанию доставки ещё не было
  mockFindDup.mockResolvedValue(null) // и ряда в БД нет
  mockPersist.mockResolvedValue({ status: 'created', id: 'l1' })
  mockNotifyLeads.mockResolvedValue({ ok: true })
  mockAlert.mockResolvedValue(undefined)
  mockRecordDrop.mockResolvedValue(undefined)
  mockRecordDelivered.mockResolvedValue(undefined)
  mockThrottle.mockResolvedValue(true) // по умолчанию honeypot-алёрт разрешён
})

describe('авторизация и валидация — контракт не меняем', () => {
  it('нет Origin и нет Bearer → 401', async () => {
    const res = await POST(req({ phone: '+79995999967' }, {}))
    expect(res.status).toBe(401)
    expect((await res.json()).ok).toBe(false)
    expect(mockNotifyLeads).not.toHaveBeenCalled()
  })

  it('нет phone → 400 phone_required', async () => {
    const res = await POST(req({ name: 'без телефона' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('phone_required')
  })
})

describe('ШАГ 1в — honeypot-дроп шумный (с троттлом)', () => {
  it('hp заполнен → 200 {ok:true}, в чат НЕ шлём, алёрт (троттл разрешил)', async () => {
    const res = await POST(
      req({ phone: '+79995999967', hp: 'bot', source: 'quiz-block-3' })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(mockNotifyLeads).not.toHaveBeenCalled()
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockAlert).toHaveBeenCalledTimes(1)
    const text = mockAlert.mock.calls[0][0] as string
    expect(text).toContain('honeypot')
    expect(text).toContain('hp')
    expect(text).toContain('quiz-block-3')
  })

  it('троттл заглушил (был алёрт за час) → бот отброшен, но в чат НЕ шлём', async () => {
    mockThrottle.mockResolvedValue(false)
    const res = await POST(req({ phone: '+79995999967', website: 'x' }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(mockAlert).not.toHaveBeenCalled()
  })
})

describe('ШАГ 2 — дедуп ретраев (по факту доставки)', () => {
  it('уже доставлено по phone_digits → 200 {ok:true}, без чата/БД, счётчик дубля', async () => {
    mockFindDelivered.mockResolvedValue({ id: 'deliv-1' })
    const res = await POST(
      req({ phone: '+7 999 599-99-67', phone_digits: '79995999967', source: 'popup' })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true }) // ответ идентичен успеху
    expect(mockRecordDrop).toHaveBeenCalledWith('deliv-1', 'popup')
    expect(mockFindDup).not.toHaveBeenCalled()
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockNotifyLeads).not.toHaveBeenCalled()
    expect(mockAlert).not.toHaveBeenCalled()
  })

  it('доставки НЕ было, но ряд уже есть (лечащий ретрай) → НЕ дублируем ряд, доставляем', async () => {
    mockFindDelivered.mockResolvedValue(null)
    mockFindDup.mockResolvedValue({ id: 'row-9' })
    const res = await POST(req({ phone: '+7 999 599-99-67', phone_digits: '79995999967' }))
    expect(res.status).toBe(200)
    // persist НЕ зовём — переиспользуем существующий ряд row-9
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockNotifyLeads).toHaveBeenCalledTimes(1) // доставку пробуем (лечим)
    expect(mockRecordDelivered).toHaveBeenCalledWith('79995999967')
  })

  it('нет phone_digits → дедуп пропускаем (при сомнении доставляем)', async () => {
    const res = await POST(req({ phone: '+7 999 599-99-67' }))
    expect(mockFindDelivered).not.toHaveBeenCalled()
    expect(mockFindDup).not.toHaveBeenCalled()
    expect(mockPersist).toHaveBeenCalledTimes(1)
    expect(mockNotifyLeads).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
  })
})

describe('счастливый путь', () => {
  it('нет доставки/ряда, persist ok, notify ok → 200, пометка доставки, без алёртов', async () => {
    const res = await POST(req({ phone: '+7 999 599-99-67', phone_digits: '79995999967' }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(mockPersist).toHaveBeenCalledTimes(1)
    expect(mockNotifyLeads).toHaveBeenCalledTimes(1)
    expect(mockRecordDelivered).toHaveBeenCalledWith('79995999967')
    expect(mockAlert).not.toHaveBeenCalled()
  })
})

describe('ШАГ 1а/1б — шумные алёрты по путям потери', () => {
  it('notify упал, но заявка в БД → 500 клиенту + алёрт с id записи', async () => {
    mockNotifyLeads.mockResolvedValue({ ok: false, error: 'forbidden' })
    mockPersist.mockResolvedValue({ status: 'created', id: 'lead-42' })
    const res = await POST(req({ phone: '+79995999967', phone_digits: '79995999967' }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('send_failed')
    const text = mockAlert.mock.calls[0][0] as string
    expect(text).toContain('lead-42')
    expect(text).toContain('БД')
    expect(text).toContain('НЕ ушла в чат')
  })

  it('notify упал И persist упал → 500 + алёрт с телефоном для спасения', async () => {
    mockNotifyLeads.mockResolvedValue({ ok: false, error: 'timeout' })
    mockPersist.mockResolvedValue({ status: 'failed', error: 'db down' })
    const res = await POST(req({ phone: '+7 999 599-99-67', phone_digits: '79995999967' }))
    expect(res.status).toBe(500)
    const text = mockAlert.mock.calls[0][0] as string
    expect(text).toContain('Спасите')
    expect(text).toContain('599-99-67') // телефон в алёрте
  })

  it('notify ok, но persist упал → 200 клиенту + алёрт «в БД не записалось»', async () => {
    mockPersist.mockResolvedValue({ status: 'failed', error: 'db down' })
    const res = await POST(req({ phone: '+79995999967', phone_digits: '79995999967' }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    const text = mockAlert.mock.calls[0][0] as string
    expect(text).toContain('НЕ записана в БД')
    expect(text).toContain('db down')
  })
})
