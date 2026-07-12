import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * «Борис, почему <фраза>»: текст → CriterionId (снапшот keywords) → записи из
 * последних снапшотов decisions → light-LLM пересказ, фолбэк без LLM. Только чтение.
 */

const { mockPrisma, mockLlm, mockState } = vi.hoisted(() => ({
  mockPrisma: { borisDirectSnapshot: { findFirst: vi.fn(), findMany: vi.fn() } },
  mockLlm: vi.fn(),
  mockState: vi.fn(),
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('./llm', () => ({ callBorisDirectLlm: mockLlm }))
vi.mock('./prompts', () => ({ getBorisDirectSystemPrompt: () => 'SYS' }))
vi.mock('./state', () => ({ getDirectRoleState: mockState }))

import { explainPhrase } from './explain'
import { MICRO } from './config'

const KEYWORDS = [
  { Id: 11, Keyword: 'доставка обедов в офис' },
  { Id: 22, Keyword: 'корпоративное питание москва' },
]

function setKeywords(list: unknown) {
  mockPrisma.borisDirectSnapshot.findFirst.mockImplementation(
    async (args: { where: { kind: string } }) => (args.where.kind === 'keywords' ? { payload: list } : null)
  )
}
function setDecisions(snaps: Array<{ payload: unknown }>) {
  mockPrisma.borisDirectSnapshot.findMany.mockImplementation(
    async (args: { where: { kind: string } }) => (args.where.kind === 'decisions' ? snaps : [])
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockState.mockResolvedValue({ mode: 'LIVE', frozen: false })
  setKeywords(KEYWORDS)
  setDecisions([])
})

describe('explainPhrase', () => {
  it('известная фраза → пересказ light-LLM по её записям (записи ключа переданы в LLM)', async () => {
    setDecisions([
      {
        payload: [
          { type: 'bid', targetType: 'keyword', targetId: '11', summary: 'вход в нижний блок', reasonCode: 'PROVEN_CONVERTER_VOLUME', factors: { fromMicro: 100 * MICRO, toMicro: 150 * MICRO, targetTv: 65 } },
          { type: 'bid', targetType: 'keyword', targetId: '22', summary: 'хвост', reasonCode: 'TAIL_MIN_TV', factors: {} },
        ],
      },
    ])
    mockLlm.mockResolvedValue({ text: 'Поднял ставку по конвертеру до 150 ₽.', model: 'sonnet', costUsd: 0.001, downgraded: false })

    const out = await explainPhrase('Доставка Обедов в Офис')

    expect(out).toBe('Поднял ставку по конвертеру до 150 ₽.')
    expect(mockLlm).toHaveBeenCalledOnce()
    const call = mockLlm.mock.calls[0][0]
    expect(call.tier).toBe('light')
    expect(call.userText).toContain('"targetId":"11"')
    expect(call.userText).not.toContain('"targetId":"22"') // только записи ключа 11
  })

  it('фраза не найдена, но есть похожие → честный ответ с похожими', async () => {
    const out = await explainPhrase('обедов доставка склад')
    expect(out).toContain('Не нашёл')
    expect(out).toContain('доставка обедов в офис')
    expect(mockLlm).not.toHaveBeenCalled()
  })

  it('фраза не найдена и похожих нет → честный ответ без подсказок', async () => {
    const out = await explainPhrase('ремонт квартир под ключ')
    expect(out).toContain('Не нашёл')
    expect(out).toContain('среди живых ключей')
  })

  it('LLM упал → детерминированный фолбэк с цифрами (без нарратива)', async () => {
    setDecisions([
      {
        payload: [
          { type: 'hold', targetType: 'keyword', targetId: '11', summary: 'держим уровень — вердикт неопределён', reasonCode: 'CORE_LOWER_BLOCK', factors: { headClicks: 3, headLeads: 0, pBelow: 0.42, fromMicro: 141 * MICRO } },
        ],
      },
    ])
    mockLlm.mockRejectedValue(new Error('anthropic 529'))

    const out = await explainPhrase('доставка обедов в офис')

    expect(out).toContain('держим уровень')
    expect(out).toContain('клики 3')
    expect(out).toContain('заявки 0')
    expect(out).toContain('141 ₽')
  })

  it('фраза найдена, но решений по ней нет → честно «не записано», LLM не зовём', async () => {
    setDecisions([
      { payload: [{ type: 'bid', targetType: 'keyword', targetId: '22', summary: 'x', reasonCode: 'TAIL_MIN_TV', factors: {} }] },
    ])
    const out = await explainPhrase('доставка обедов в офис')
    expect(out).toContain('решени')
    expect(mockLlm).not.toHaveBeenCalled()
  })
})
