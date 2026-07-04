import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DailyReportData } from './brain'

const { mockCallLlm, mockGetState, mockGetPrompt, mockGetLessons, mockFormatLessonsBlock } =
  vi.hoisted(() => ({
    mockCallLlm: vi.fn(),
    mockGetState: vi.fn(),
    mockGetPrompt: vi.fn(),
    mockGetLessons: vi.fn(),
    mockFormatLessonsBlock: vi.fn(),
  }))

vi.mock('./llm', () => ({ callBorisDirectLlm: mockCallLlm }))
vi.mock('./state', () => ({ getDirectRoleState: mockGetState }))
vi.mock('./prompts', () => ({ getBorisDirectSystemPrompt: mockGetPrompt }))
vi.mock('./lessons', () => ({
  getActiveLessonsForContext: mockGetLessons,
  formatLessonsBlock: mockFormatLessonsBlock,
}))

import {
  buildDailyDataBlock,
  buildWeeklyDataBlock,
  buildMonthlyDataBlock,
  generateDailyReportText,
  generateWeeklyReportText,
  generateMonthlyReportText,
  formatAnomalyMessage,
  type DailyReportInput,
} from './report-texts'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetState.mockResolvedValue({ mode: 'OBSERVE', frozen: false, autoNegativesEnabled: false })
  mockGetPrompt.mockReturnValue('SYSTEM_PROMPT')
  mockCallLlm.mockResolvedValue({ text: 'ТЕКСТ ОТ LLM', model: 'opus', costUsd: 0.1, downgraded: false })
  // Дефолт: уроков нет; formatLessonsBlock повторяет контракт соседнего модуля
  // ('' если пусто, иначе секция «ОПЫТ»).
  mockGetLessons.mockResolvedValue([])
  mockFormatLessonsBlock.mockImplementation((lessons: Array<{ text: string }>) =>
    lessons.length === 0
      ? ''
      : ['ОПЫТ (мои проверенные уроки):', ...lessons.map((l) => `- ${l.text}`)].join('\n')
  )
})

const day = (over: Partial<DailyReportData> = {}): DailyReportData => ({
  dateLabel: '2026-07-01',
  spendRub: 2500.4,
  clicks: 42,
  impressions: 1000,
  ctr: 4.2,
  leadsTotal: 5,
  leadsFromDirect: 3,
  costPerLeadRub: 833.5,
  topQueries: [{ query: 'обеды в офис', clicks: 10, costRub: 500.7, conversions: 2 }],
  quarantine: false,
  ...over,
})

const dailyInput = (over: Partial<DailyReportInput> = {}): DailyReportInput => ({
  data: day(),
  appliedSummaries: ['минус-фразы (2): а, б'],
  wouldDoSummaries: [],
  proposalsCreated: ['Минус-фразы: 3 шт'],
  anomalies: [],
  observe: true,
  ...over,
})

describe('formatAnomalyMessage — детерминированно, без LLM', () => {
  it('critical → 🚨', () => {
    expect(formatAnomalyMessage({ severity: 'critical', kind: 'x', text: 'расход улетел' })).toBe(
      '🚨 расход улетел'
    )
  })

  it('warn → ⚠️', () => {
    expect(formatAnomalyMessage({ severity: 'warn', kind: 'x', text: 'ноль заявок' })).toBe(
      '⚠️ ноль заявок'
    )
  })
})

describe('buildDailyDataBlock — числа форматирует код', () => {
  it('рубли без копеек, CTR с 2 знаками, счётчики заявок', () => {
    const block = buildDailyDataBlock(dailyInput())
    expect(block).toContain('за 2026-07-01')
    expect(block).toContain('Расход: 2500 ₽')
    expect(block).toContain('CTR: 4.20%')
    expect(block).toContain('Заявок всего: 5, из Директа: 3')
    expect(block).toContain('Цена заявки: 834 ₽')
    expect(block).toContain('«обеды в офис»: 10 кликов, 501 ₽, конверсий 2')
  })

  it('null → «нет данных», пустой топ → «нет данных»', () => {
    const block = buildDailyDataBlock(
      dailyInput({
        data: day({ spendRub: null, clicks: null, impressions: null, ctr: null, costPerLeadRub: null, topQueries: [] }),
      })
    )
    expect(block).toContain('Расход: нет данных')
    expect(block).toContain('CTR: нет данных')
    expect(block).toContain('Цена заявки: нет данных')
  })

  it('сделал / сделал бы / предложения / карантин / режим', () => {
    const block = buildDailyDataBlock(
      dailyInput({
        data: day({ quarantine: true }),
        appliedSummaries: [],
        wouldDoSummaries: ['ставки: 3 фразы'],
        observe: true,
      })
    )
    expect(block).toContain('Карантин: да')
    expect(block).toContain('наблюдение')
    expect(block).toContain('ЧТО СДЕЛАЛ:\nничего')
    expect(block).toContain('- ставки: 3 фразы')
    expect(block).toContain('- Минус-фразы: 3 шт')
  })

  it('одинаковый вход → одинаковый выход (детерминизм)', () => {
    expect(buildDailyDataBlock(dailyInput())).toBe(buildDailyDataBlock(dailyInput()))
  })
})

describe('buildDailyDataBlock — секция ОПЫТ', () => {
  const LESSONS_BLOCK = 'ОПЫТ (мои проверенные уроки):\n- фразы с «недорого» не конвертят'

  it('lessonsBlock непустой → отдельная секция в конце блока', () => {
    const block = buildDailyDataBlock(dailyInput({ lessonsBlock: LESSONS_BLOCK }))
    expect(block.endsWith(`\n\n${LESSONS_BLOCK}`)).toBe(true)
  })

  it('без lessonsBlock / пустой → секции нет, никаких пустых заголовков', () => {
    const without = buildDailyDataBlock(dailyInput())
    expect(without).not.toContain('ОПЫТ')
    expect(buildDailyDataBlock(dailyInput({ lessonsBlock: '' }))).toBe(without)
    expect(buildDailyDataBlock(dailyInput({ lessonsBlock: '   ' }))).toBe(without)
  })
})

describe('buildDailyDataBlock — консистентность аномалий (ссылка на утренние алёрты)', () => {
  it('были алёрты сегодня, тексты не переданы → сводка ССЫЛАЕТСЯ, а не пишет «нет»', () => {
    const block = buildDailyDataBlock(dailyInput({ anomalies: [], anomaliesFiredToday: 2 }))
    expect(block).toContain('утром было 2 алерта')
    // В секции аномалий НЕ должно стоять «нет» вместо ссылки (это и был баг).
    expect(block).not.toContain('сообщениями):\nнет')
  })

  it('алёртов сегодня не было (0 / не передано) → «нет», прежнее поведение', () => {
    expect(buildDailyDataBlock(dailyInput({ anomalies: [], anomaliesFiredToday: 0 }))).toContain(
      'сообщениями):\nнет'
    )
    expect(buildDailyDataBlock(dailyInput({ anomalies: [] }))).toContain('сообщениями):\nнет')
  })

  it('переданы ТЕКСТЫ аномалий → перечисляем их (текст важнее счётчика)', () => {
    const block = buildDailyDataBlock(
      dailyInput({ anomalies: ['ADD_METRICA_TAG=NO'], anomaliesFiredToday: 5 })
    )
    expect(block).toContain('- ADD_METRICA_TAG=NO')
    expect(block).not.toContain('утром было')
  })

  it('русская форма числа: 1 алерт / 2 алерта / 5 алертов', () => {
    expect(buildDailyDataBlock(dailyInput({ anomaliesFiredToday: 1 })).endsWith('утром было 1 алерт')).toBe(true)
    expect(buildDailyDataBlock(dailyInput({ anomaliesFiredToday: 2 })).endsWith('утром было 2 алерта')).toBe(true)
    expect(buildDailyDataBlock(dailyInput({ anomaliesFiredToday: 5 })).endsWith('утром было 5 алертов')).toBe(true)
  })
})

describe('generateDailyReportText', () => {
  it('heavy, critical=false, mode из state, цифры в userText, ответ LLM как есть', async () => {
    const text = await generateDailyReportText(dailyInput())
    expect(text).toBe('ТЕКСТ ОТ LLM')
    expect(mockGetPrompt).toHaveBeenCalledWith({ mode: 'OBSERVE', frozen: false })
    const call = mockCallLlm.mock.calls[0][0]
    expect(call.purpose).toBe('daily_report')
    expect(call.tier).toBe('heavy')
    expect(call.critical).toBe(false)
    expect(call.system).toBe('SYSTEM_PROMPT')
    expect(call.userText).toContain('НЕ менять')
    expect(call.userText).toContain('Расход: 2500 ₽')
  })

  it('LLM упал → фолбэк с шапкой и сырым блоком (отчёт обязан уйти)', async () => {
    mockCallLlm.mockRejectedValue(new Error('overloaded'))
    const text = await generateDailyReportText(dailyInput())
    expect(text).toContain('📊 Дневной отчёт (без обработки — LLM недоступен)')
    expect(text).toContain('Расход: 2500 ₽')
  })

  it('LLM вернул пустой текст → тоже фолбэк', async () => {
    mockCallLlm.mockResolvedValue({ text: '  ', model: 'opus', costUsd: 0, downgraded: false })
    const text = await generateDailyReportText(dailyInput())
    expect(text).toContain('LLM недоступен')
  })
})

describe('generateDailyReportText — секция ОПЫТ', () => {
  it('lessonsBlock не передан → сам подтягивает уроки, секция в userText + инструкция про ОПЫТ', async () => {
    mockGetLessons.mockResolvedValue([
      { id: 'l1', kind: 'query_pattern', text: 'фразы с «недорого» не конвертят' },
    ])

    await generateDailyReportText(dailyInput())

    expect(mockGetLessons).toHaveBeenCalledTimes(1)
    const call = mockCallLlm.mock.calls[0][0]
    expect(call.userText).toContain('ОПЫТ (мои проверенные уроки):')
    expect(call.userText).toContain('- фразы с «недорого» не конвертят')
    expect(call.userText).toContain('не выдумывай новых')
  })

  it('lessonsBlock передан → getActiveLessonsForContext НЕ зовём, блок уходит как есть', async () => {
    await generateDailyReportText(
      dailyInput({ lessonsBlock: 'ОПЫТ (мои проверенные уроки):\n- готовый урок' })
    )
    expect(mockGetLessons).not.toHaveBeenCalled()
    expect(mockCallLlm.mock.calls[0][0].userText).toContain('- готовый урок')
  })

  it('уроков нет → секции ОПЫТ в userText нет (пустых заголовков не шлём)', async () => {
    await generateDailyReportText(dailyInput())
    expect(mockGetLessons).toHaveBeenCalledTimes(1)
    expect(mockCallLlm.mock.calls[0][0].userText).not.toContain('ОПЫТ (мои проверенные уроки)')
  })

  it('LLM упал → фолбэк-блок включает секцию ОПЫТ как есть', async () => {
    mockCallLlm.mockRejectedValue(new Error('down'))
    mockGetLessons.mockResolvedValue([{ id: 'l1', kind: 'query_pattern', text: 'урок про минуса' }])

    const text = await generateDailyReportText(dailyInput())

    expect(text).toContain('LLM недоступен')
    expect(text).toContain('ОПЫТ (мои проверенные уроки):')
    expect(text).toContain('- урок про минуса')
  })

  it('getActiveLessonsForContext упал → отчёт уходит без секции ОПЫТ, не падаем', async () => {
    mockGetLessons.mockRejectedValue(new Error('db down'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const text = await generateDailyReportText(dailyInput())

    expect(text).toBe('ТЕКСТ ОТ LLM')
    expect(mockCallLlm.mock.calls[0][0].userText).not.toContain('ОПЫТ (мои проверенные уроки)')
    errorSpy.mockRestore()
  })
})

describe('buildWeeklyDataBlock — агрегация кодом', () => {
  const days = [
    day({ dateLabel: '2026-06-29', spendRub: 1000, clicks: 20, impressions: 500, leadsTotal: 2, leadsFromDirect: 1, topQueries: [{ query: 'пустой запрос', clicks: 5, costRub: 300, conversions: 0 }] }),
    day({ dateLabel: '2026-06-30', spendRub: 2000, clicks: 30, impressions: 500, leadsTotal: 3, leadsFromDirect: 2, topQueries: [{ query: 'обеды в офис', clicks: 10, costRub: 400, conversions: 3 }] }),
  ]

  it('суммы, средняя цена заявки, динамика по дням, лучшие/худшие запросы', () => {
    const block = buildWeeklyDataBlock(days, { llmSpendUsd: 1.234, llmCalls: 12, proposalsPending: 2 })
    expect(block).toContain('Расход: 3000 ₽')
    expect(block).toContain('Заявок всего: 5, из Директа: 3')
    expect(block).toContain('Средняя цена заявки: 1000 ₽') // 3000 / 3 — код, не LLM
    expect(block).toContain('CTR: 5.00%') // 50 кликов / 1000 показов
    expect(block).toContain('- 2026-06-29: расход 1000 ₽')
    expect(block).toContain('- 2026-06-30: расход 2000 ₽')
    expect(block).toContain('«обеды в офис»: конверсий 3')
    expect(block).toContain('«пустой запрос»: 0 конверсий')
    expect(block).toContain('Предложений без ответа владельца: 2')
    expect(block).toContain('~1.23 $ / 12 обращений')
  })

  it('нет данных → блок не падает, заявок 0 → цена заявки «нет данных»', () => {
    const block = buildWeeklyDataBlock([], { llmSpendUsd: 0, llmCalls: 0, proposalsPending: 0 })
    expect(block).toContain('данных за неделю нет')
    expect(block).toContain('Средняя цена заявки: нет данных')
  })

  it('lessonsSummary передан → строка «Уроки за неделю» добавлена кодом', () => {
    const block = buildWeeklyDataBlock([day()], {
      llmSpendUsd: 0,
      llmCalls: 0,
      proposalsPending: 0,
      lessonsSummary: { created: 2, confirmed: 1, refuted: 0, staled: 3 },
    })
    expect(block).toContain('Уроки за неделю: новых 2, подтверждено 1, опровергнуто 0, устарело 3')
  })

  it('без lessonsSummary строки про уроки нет', () => {
    const block = buildWeeklyDataBlock([day()], { llmSpendUsd: 0, llmCalls: 0, proposalsPending: 0 })
    expect(block).not.toContain('Уроки за неделю')
  })
})

describe('generateWeeklyReportText', () => {
  it('heavy critical=false, purpose weekly_report', async () => {
    await generateWeeklyReportText([day()], { llmSpendUsd: 1, llmCalls: 5, proposalsPending: 0 })
    const call = mockCallLlm.mock.calls[0][0]
    expect(call.purpose).toBe('weekly_report')
    expect(call.tier).toBe('heavy')
    expect(call.critical).toBe(false)
  })

  it('фолбэк при ошибке LLM', async () => {
    mockCallLlm.mockRejectedValue(new Error('down'))
    const text = await generateWeeklyReportText([day()], { llmSpendUsd: 1, llmCalls: 5, proposalsPending: 1 })
    expect(text).toContain('📊 Недельный отчёт (без обработки — LLM недоступен)')
    expect(text).toContain('ИТОГИ НЕДЕЛИ')
  })
})

describe('buildMonthlyDataBlock — динамика цены заявки по неделям', () => {
  it('группировка по неделям с понедельника', () => {
    const days = [
      // 2026-06-01 — понедельник; 2026-06-08 — следующий.
      day({ dateLabel: '2026-06-02', spendRub: 1000, leadsFromDirect: 2 }),
      day({ dateLabel: '2026-06-03', spendRub: 1000, leadsFromDirect: 2 }),
      day({ dateLabel: '2026-06-09', spendRub: 3000, leadsFromDirect: 2 }),
    ]
    const block = buildMonthlyDataBlock(days, { llmSpendUsd: 0, llmCalls: 0, monthLabel: 'июнь 2026' })
    expect(block).toContain('июнь 2026')
    expect(block).toContain('- неделя с 2026-06-01: расход 2000 ₽, заявок из Директа 4, цена заявки 500 ₽')
    expect(block).toContain('- неделя с 2026-06-08: расход 3000 ₽, заявок из Директа 2, цена заявки 1500 ₽')
  })
})

describe('generateMonthlyReportText', () => {
  const extras = { llmSpendUsd: 4.5678, llmCalls: 90, monthLabel: 'июнь 2026' }
  const llmLine = '💰 На аналитику потрачено ~4.57 $ / 90 обращений к LLM — это отдельные деньги, не рекламный бюджет.'

  it('heavy critical=true, строка про LLM-деньги добавлена КОДОМ в конце', async () => {
    const text = await generateMonthlyReportText([day()], extras)
    const call = mockCallLlm.mock.calls[0][0]
    expect(call.purpose).toBe('monthly_report')
    expect(call.critical).toBe(true)
    expect(text).toBe(`ТЕКСТ ОТ LLM\n\n${llmLine}`)
  })

  it('фолбэк при ошибке LLM — строка про LLM-деньги всё равно в конце', async () => {
    mockCallLlm.mockRejectedValue(new Error('down'))
    const text = await generateMonthlyReportText([day()], extras)
    expect(text).toContain('📊 Месячный отчёт (без обработки — LLM недоступен)')
    expect(text.endsWith(llmLine)).toBe(true)
  })
})
