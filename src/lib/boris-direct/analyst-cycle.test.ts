import { describe, it, expect, vi } from 'vitest'
import { runAnalystCycle, type AnalystCycleDeps } from './analyst-cycle'
import type { AnalystQuestion } from './questions'
import type { AnalystPassResult } from './analyst'

const NOW = new Date('2026-07-14T07:30:00Z') // МСК-день 2026-07-14

function q(over: Partial<AnalystQuestion>): AnalystQuestion {
  return {
    id: 'q1',
    question: 'вопрос',
    status: 'open',
    check: 'проверка',
    result: null,
    createdMsk: '2026-07-13',
    updatedMsk: '2026-07-13',
    ...over,
  }
}

function baseDeps(over: Partial<AnalystCycleDeps> = {}): AnalystCycleDeps {
  const emptyPass: AnalystPassResult = { kept: [], dropped: [], raw: '', costUsd: 0, ok: true }
  return {
    isEnabled: () => true,
    now: NOW,
    getActive: vi.fn(async () => []),
    getLatest: vi.fn(async () => []),
    updateQuestion: vi.fn(async () => {}),
    createQuestion: vi.fn(async () => {}),
    executeSpec: vi.fn(async () => ({ status: 'refuted' as const, result: 'нет', effectRub: 0 })),
    buildDashboard: vi.fn(async () => 'ДАШБОРД'),
    runPass: vi.fn(async () => emptyPass),
    escalate: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    ...over,
  }
}

describe('runAnalystCycle: предохранитель', () => {
  it('флаг выключен → тихий скип, LLM/проверки не зовём', async () => {
    const deps = baseDeps({ isEnabled: () => false })
    const r = await runAnalystCycle(deps)
    expect(r.skipped).toBe('disabled')
    expect(deps.runPass).not.toHaveBeenCalled()
    expect(deps.buildDashboard).not.toHaveBeenCalled()
  })
})

describe('runAnalystCycle: исполнение назначенных проверок', () => {
  it('открытый вопрос с checkSpec исполняется, статус пишется', async () => {
    const deps = baseDeps({
      getActive: vi.fn(async () => [q({ id: 'qA', checkSpec: { key: 'metrika_goal_series', params: {} } })]),
      executeSpec: vi.fn(async () => ({ status: 'confirmed' as const, result: 'серия 3 дн, потеря 20000 ₽', effectRub: 20000 })),
    })
    await runAnalystCycle(deps)
    expect(deps.executeSpec).toHaveBeenCalledWith({ key: 'metrika_goal_series', params: {} }, NOW)
    expect(deps.updateQuestion).toHaveBeenCalledWith(
      'qA',
      expect.objectContaining({ status: 'confirmed', result: expect.stringMatching(/серия/) }),
      NOW
    )
  })

  it('confirmed И эффект ≥ порога → эскалация владельцу + отметка escalatedMsk', async () => {
    const escalate = vi.fn(async (_text: string) => {})
    const deps = baseDeps({
      getActive: vi.fn(async () => [q({ id: 'qA', checkSpec: { key: 'metrika_goal_series', params: {} } })]),
      executeSpec: vi.fn(async () => ({ status: 'confirmed' as const, result: 'потеря 20000 ₽', effectRub: 20000 })),
      escalate,
    })
    const r = await runAnalystCycle(deps)
    expect(escalate).toHaveBeenCalledTimes(1)
    expect(escalate.mock.calls[0][0]).toMatch(/20000/)
    expect(r.escalated).toBe(1)
    expect(deps.updateQuestion).toHaveBeenCalledWith('qA', expect.objectContaining({ escalatedMsk: '2026-07-14' }), NOW)
  })

  it('confirmed, но эффект НИЖЕ порога → НЕ эскалируем (тихо в память)', async () => {
    const escalate = vi.fn(async (_text: string) => {})
    const deps = baseDeps({
      getActive: vi.fn(async () => [q({ id: 'qA', checkSpec: { key: 'ladder_medians', params: {} } })]),
      executeSpec: vi.fn(async () => ({ status: 'confirmed' as const, result: 'дрейф 25%', effectRub: 0 })),
      escalate,
    })
    const r = await runAnalystCycle(deps)
    expect(escalate).not.toHaveBeenCalled()
    expect(r.escalated).toBe(0)
  })

  it('уже эскалированный вопрос повторно не шлём', async () => {
    const escalate = vi.fn(async (_text: string) => {})
    const deps = baseDeps({
      getActive: vi.fn(async () => [
        q({ id: 'qA', status: 'confirmed', escalatedMsk: '2026-07-13', checkSpec: { key: 'metrika_goal_series', params: {} } }),
      ]),
      executeSpec: vi.fn(async () => ({ status: 'confirmed' as const, result: 'потеря 20000 ₽', effectRub: 20000 })),
      escalate,
    })
    await runAnalystCycle(deps)
    expect(escalate).not.toHaveBeenCalled()
  })

  it('вопрос без checkSpec не исполняется', async () => {
    const deps = baseDeps({ getActive: vi.fn(async () => [q({ id: 'qA' })]) })
    await runAnalystCycle(deps)
    expect(deps.executeSpec).not.toHaveBeenCalled()
  })
})

describe('runAnalystCycle: постановка новых вопросов', () => {
  const draft = {
    topicKey: 'funnel_zero_series',
    question: '0 заявок при живых визитах?',
    check: 'серия цели',
    checkSpec: { key: 'metrika_goal_series', params: { windowDays: 14 } },
  }

  it('оставленные драфты создают вопросы и уходят в daily-секцию', async () => {
    const deps = baseDeps({
      runPass: vi.fn(async () => ({ kept: [draft], dropped: [], raw: 'x', costUsd: 0.01, ok: true })),
    })
    const r = await runAnalystCycle(deps)
    expect(deps.createQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ topicKey: 'funnel_zero_series', checkSpec: draft.checkSpec }),
      // now передаётся как поле input.now — проверим отдельно ниже
    )
    expect(r.asked).toBe(1)
    expect(deps.notify).toHaveBeenCalled()
    expect((deps.notify as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/0 заявок/)
  })

  it('тема на cooldown не создаётся повторно', async () => {
    const deps = baseDeps({
      runPass: vi.fn(async () => ({ kept: [draft], dropped: [], raw: 'x', costUsd: 0.01, ok: true })),
      getLatest: vi.fn(async () => [q({ id: 'old', topicKey: 'funnel_zero_series', createdMsk: '2026-07-13' })]),
    })
    const r = await runAnalystCycle(deps)
    expect(deps.createQuestion).not.toHaveBeenCalled()
    expect(r.asked).toBe(0)
  })

  it('дубликат темы внутри одного прохода создаётся один раз', async () => {
    const deps = baseDeps({
      runPass: vi.fn(async () => ({ kept: [draft, { ...draft, question: 'ещё раз' }], dropped: [], raw: 'x', costUsd: 0, ok: true })),
    })
    const r = await runAnalystCycle(deps)
    expect(r.asked).toBe(1)
  })

  it('нет новых вопросов и нет эскалаций → notify не зовём (тишина — норма)', async () => {
    const deps = baseDeps()
    await runAnalystCycle(deps)
    expect(deps.notify).not.toHaveBeenCalled()
  })
})
