import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * boris-direct-watch cron: интрадей-надзор + катастрофа-детектор расхода.
 * Мокаем prisma / direct-client / reports.pollReport / telegram / write-gate;
 * classifyBudgetOveruse, buildTodaySpendReportBody, parseReportTsv, mskDay —
 * реальные (чистые). Дёргаем handler напрямую.
 */

const { mockPrisma, mockGetCampaign, mockPoll, mockSend, mockSuspend } = vi.hoisted(() => ({
  mockPrisma: { borisDirectSnapshot: { findMany: vi.fn(), create: vi.fn() } },
  mockGetCampaign: vi.fn(),
  mockPoll: vi.fn(),
  mockSend: vi.fn(),
  mockSuspend: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/boris-direct/direct-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/boris-direct/direct-client')>()
  return { ...actual, getCampaignState: mockGetCampaign }
})
vi.mock('@/lib/boris-direct/reports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/boris-direct/reports')>()
  return { ...actual, pollReport: mockPoll }
})
vi.mock('@/lib/boris-direct/telegram', () => ({ sendToDirectChat: mockSend }))
vi.mock('@/lib/boris-direct/write-gate', () => ({ suspendCampaignEmergency: mockSuspend }))

import { handler } from './route'
import { DIRECT_CAMPAIGN_ID } from '@/lib/boris-direct/config'

const REQ = new Request('http://x/api/cron/boris-direct-watch')

/** Здоровая крутящаяся кампания с тегом YES, бюджет 3000 ₽. */
function healthyCampaign(over: Record<string, unknown> = {}) {
  return {
    Id: DIRECT_CAMPAIGN_ID,
    Name: 'Будни — Поиск',
    State: 'ON',
    Status: 'ACCEPTED',
    StatusPayment: 'ALLOWED',
    Type: 'TEXT_CAMPAIGN',
    DailyBudget: { Amount: 3000 * 1_000_000, Mode: 'STANDARD' },
    TextCampaign: { Settings: [{ Option: 'ADD_METRICA_TAG', Value: 'YES' }] },
    ...over,
  }
}

/** TSV интрадей-отчёта расхода за сегодня. */
function spendTsv(costRub: number): string {
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10)
  return `Date\tClicks\tCost\n${today}\t5\t${costRub.toFixed(2)}\n`
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.borisDirectSnapshot.findMany.mockResolvedValue([]) // сегодня алёртов ещё не было
  mockPrisma.borisDirectSnapshot.create.mockResolvedValue({})
  mockGetCampaign.mockResolvedValue(healthyCampaign())
  mockSend.mockResolvedValue(undefined)
  mockSuspend.mockResolvedValue({ applied: true, logId: 'log-1' })
})

describe('катастрофа-детектор расхода', () => {
  it('расход ниже порогов → тишина (без suspend, без алерта катастрофы)', async () => {
    mockPoll.mockResolvedValue({ status: 'ready', tsv: spendTsv(1200) }) // 0.4×

    const res = await handler(REQ)
    const json = await res.json()

    expect(json.catastrophe).toBe('none')
    expect(mockSuspend).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('расход ≥ 1.0× → один мягкий алерт, БЕЗ действий', async () => {
    mockPoll.mockResolvedValue({ status: 'ready', tsv: spendTsv(3200) }) // 1.07×

    const res = await handler(REQ)
    const json = await res.json()

    expect(json.catastrophe).toBe('soft')
    expect(mockSuspend).not.toHaveBeenCalled()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend.mock.calls[0][0]).toContain('слежу, действий пока не предпринимаю')
    // Снапшот дедупа записан.
    expect(mockPrisma.borisDirectSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'watch_alert' }) })
    )
  })

  it('мягкий алерт НЕ дублируется при повторном watch (дедуп по дню)', async () => {
    mockPoll.mockResolvedValue({ status: 'ready', tsv: spendTsv(3200) })
    mockPrisma.borisDirectSnapshot.findMany.mockResolvedValue([{ payload: { kind: 'catastrophe_soft' } }])

    const res = await handler(REQ)
    const json = await res.json()

    expect(json.catastrophe).toBe('soft')
    expect(mockSend).not.toHaveBeenCalled() // уже алертили сегодня
  })

  it('расход ≥ 1.5× → suspendCampaignEmergency однократно + алерт', async () => {
    mockPoll.mockResolvedValue({ status: 'ready', tsv: spendTsv(4600) }) // 1.53×

    const res = await handler(REQ)
    const json = await res.json()

    expect(json.catastrophe).toBe('hard')
    expect(mockSuspend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend.mock.calls[0][0]).toContain('ОСТАНОВЛЕНА АВАРИЙНО')
  })

  it('уже suspended (State != ON) → suspend НЕ вызывается (no-op)', async () => {
    mockGetCampaign.mockResolvedValue(healthyCampaign({ State: 'SUSPENDED' }))
    mockPoll.mockResolvedValue({ status: 'ready', tsv: spendTsv(4600) })

    await handler(REQ)

    expect(mockSuspend).not.toHaveBeenCalled()
  })

  it('жёсткий путь: повторный watch не дублирует suspend (State уже SUSPENDED) и алерт (дедуп)', async () => {
    mockGetCampaign.mockResolvedValue(healthyCampaign({ State: 'SUSPENDED' }))
    mockPrisma.borisDirectSnapshot.findMany.mockResolvedValue([{ payload: { kind: 'catastrophe_hard' } }])
    mockPoll.mockResolvedValue({ status: 'ready', tsv: spendTsv(4600) })

    const res = await handler(REQ)
    const json = await res.json()

    expect(json.catastrophe).toBe('hard')
    expect(mockSuspend).not.toHaveBeenCalled()
    // watch_state алерт мог быть, но катастрофа-алерт — нет (дедуп + не тот текст).
    const catCall = mockSend.mock.calls.find((c) => String(c[0]).includes('АВАРИЙНО'))
    expect(catCall).toBeUndefined()
  })

  it('жёсткий путь: suspend ПРОВАЛИЛСЯ (applied=false) → алерт есть, но дедуп НЕ пишем (эскалация на след. тике)', async () => {
    mockPoll.mockResolvedValue({ status: 'ready', tsv: spendTsv(4600) })
    mockSuspend.mockResolvedValue({ applied: false, logId: 'l', writeErrors: ['9000: server error'] })

    await handler(REQ)

    // Владельцу ушёл алерт (не заглушили).
    expect(mockSend.mock.calls.some((c) => /ошибку API|НЕ остановлена/.test(String(c[0])))).toBe(true)
    // Дедуп-снапшот 'catastrophe_hard' НЕ записан → следующий watch повторит алерт.
    const hardSaves = mockPrisma.borisDirectSnapshot.create.mock.calls.filter(
      (c) => (c[0].data.payload as { kind?: string })?.kind === 'catastrophe_hard'
    )
    expect(hardSaves.length).toBe(0)
  })

  it('жёсткий путь: suspend УСПЕШЕН (applied=true) → дедуп записан (алерт один раз в день)', async () => {
    mockPoll.mockResolvedValue({ status: 'ready', tsv: spendTsv(4600) })
    mockSuspend.mockResolvedValue({ applied: true, logId: 'l' })

    await handler(REQ)

    const hardSaves = mockPrisma.borisDirectSnapshot.create.mock.calls.filter(
      (c) => (c[0].data.payload as { kind?: string })?.kind === 'catastrophe_hard'
    )
    expect(hardSaves.length).toBe(1)
  })

  it('FAIL-SAFE: интрадей-отчёт упал → НЕ suspend, НЕ катастрофа-алерт', async () => {
    mockPoll.mockResolvedValue({ status: 'failed', error: 'HTTP 500: code=52 (request_id=abc)' })

    const res = await handler(REQ)
    const json = await res.json()

    expect(json.catastrophe).toBe('none')
    expect(mockSuspend).not.toHaveBeenCalled()
    const catCall = mockSend.mock.calls.find((c) => /АВАРИЙНО|слежу/.test(String(c[0])))
    expect(catCall).toBeUndefined()
  })

  it('OBSERVE/стоп-кран (gate.applied=false) при ≥1.5× → алерт «сделал бы», без ложного «остановлена»', async () => {
    mockPoll.mockResolvedValue({ status: 'ready', tsv: spendTsv(4600) })
    mockSuspend.mockResolvedValue({ applied: false, logId: 'log-obs' })

    await handler(REQ)

    expect(mockSuspend).toHaveBeenCalledTimes(1)
    expect(mockSend.mock.calls[0][0]).toContain('сделал бы')
    expect(mockSend.mock.calls[0][0]).not.toContain('ОСТАНОВЛЕНА АВАРИЙНО')
  })
})
