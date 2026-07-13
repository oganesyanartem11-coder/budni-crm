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

describe('М3: строка недорасхода в дневном блоке', () => {
  it('расход X из Y (Z%) + гейт открыт при недорасходе', () => {
    const block = buildDailyDataBlock(
      dailyInput({
        data: day({ spendRub: 1200, underspend: { spentYesterdayRub: 1200, dailyBudgetRub: 3000, gateOpen: true, medianRub: 1000 } }),
      })
    )
    expect(block).toContain('Расход 1200 ₽ из 3000 ₽ (40%)')
    expect(block).toContain('гейт недорасхода: открыт')
  })
  it('гейт закрыт при расходе у нормы; нет данных бюджета → строки нет', () => {
    const closed = buildDailyDataBlock(
      dailyInput({ data: day({ spendRub: 2900, underspend: { spentYesterdayRub: 2900, dailyBudgetRub: 3000, gateOpen: false, medianRub: 2800 } }) })
    )
    expect(closed).toContain('гейт недорасхода: закрыт')
    const noBudget = buildDailyDataBlock(dailyInput()) // underspend не задан
    expect(noBudget).not.toContain('гейт недорасхода')
  })
})

describe('М3.5: строка ввода портфеля (ramp-in) в дневном блоке', () => {
  it('применено X из Y плановых, осталось ~Z — когда есть остаток', () => {
    const block = buildDailyDataBlock(
      dailyInput({ data: day({ portfolioRampIn: { applied: 40, planned: 93, deferred: 53 } }) })
    )
    expect(block).toContain('ввод портфеля: применено 40 из 93 плановых')
    expect(block).toContain('осталось ~53')
  })
  it('нет остатка (deferred=0) → строки нет (штатный тик, не метрим)', () => {
    const block = buildDailyDataBlock(
      dailyInput({ data: day({ portfolioRampIn: { applied: 5, planned: 5, deferred: 0 } }) })
    )
    expect(block).not.toContain('ввод портфеля')
  })
  it('поле не задано → строки нет', () => {
    expect(buildDailyDataBlock(dailyInput())).not.toContain('ввод портфеля')
  })
})

describe('М5: строка прогноз/факт в дневном блоке', () => {
  it('forecastLine задан → строка «Прогноз/факт: …»', () => {
    const block = buildDailyDataBlock(
      dailyInput({ forecastLine: 'клики: ждал 60±3, факт 58; расход: ждал 5000±283 ₽, факт 4900 ₽' })
    )
    expect(block).toContain('Прогноз/факт: клики: ждал 60±3')
  })
  it('forecastLine не задан → строки нет', () => {
    expect(buildDailyDataBlock(dailyInput())).not.toContain('Прогноз/факт')
  })
})

describe('М5: секция «Деньги» в недельном блоке', () => {
  const days = [day({ dateLabel: '2026-07-06' })]
  const rev = (over = {}) => ({
    llmSpendUsd: 0,
    llmCalls: 0,
    proposalsPending: 0,
    ...over,
  })
  it('выручка есть → суммы, фразы, средний чек vs LEAD_VALUE (константу не меняем)', () => {
    const block = buildWeeklyDataBlock(days, rev({
      revenue: {
        weekly: { byPhrase: [{ query: 'обеды в офис', revenue: 150000, deals: 2 }], unattributedRevenue: 0, unattributedDeals: 0, totalRevenue: 150000, dealCount: 2, avgCheckRub: 75000 },
        allTime: { byPhrase: [{ query: 'обеды в офис', revenue: 150000, deals: 2 }], unattributedRevenue: 20000, unattributedDeals: 1, totalRevenue: 170000, dealCount: 3, avgCheckRub: 56666.67 },
      },
    }))
    expect(block).toContain('ДЕНЬГИ')
    expect(block).toContain('Выручка за неделю: 150 000 ₽ (2 сделок')
    expect(block).toContain('всего: 170 000 ₽ (3)')
    expect(block).toContain('«обеды в офис»: 150 000 ₽ (2)')
    expect(block).toContain('без атрибуции (нет utm_term): 20 000 ₽ (1)')
    expect(block).toContain('vs ценность заявки в модели 20 000 ₽')
    expect(block).toContain('LEAD_VALUE не меняю')
  })
  it('сделок нет → приглашение отмечать, без цифр', () => {
    const block = buildWeeklyDataBlock(days, rev({
      revenue: {
        weekly: { byPhrase: [], unattributedRevenue: 0, unattributedDeals: 0, totalRevenue: 0, dealCount: 0, avgCheckRub: null },
        allTime: { byPhrase: [], unattributedRevenue: 0, unattributedDeals: 0, totalRevenue: 0, dealCount: 0, avgCheckRub: null },
      },
    }))
    expect(block).toContain('сделок пока не отмечено')
  })
  it('revenue не задан → секции нет (обратная совместимость)', () => {
    expect(buildWeeklyDataBlock(days, rev())).not.toContain('ДЕНЬГИ')
  })
})

describe('М5: блок «эффект первой порции» в недельном блоке', () => {
  const days = [day({ dateLabel: '2026-07-06' })]
  const base = { llmSpendUsd: 0, llmCalls: 0, proposalsPending: 0 }
  const metrics = (o: Partial<{ keywords: number; clicks: number; spendRub: number; conversions: number; days: number; impressions: number }> = {}) => ({
    keywords: o.keywords ?? 39, days: o.days ?? 2, impressions: o.impressions ?? 1000,
    clicks: o.clicks ?? 20, spendRub: o.spendRub ?? 2000, conversions: o.conversions ?? 1,
  })

  it('мало данных → «вывод рано» без вердикта, цифры есть', () => {
    const block = buildWeeklyDataBlock(days, {
      ...base,
      cohortEffect: {
        raiseDay: '2026-07-10',
        cohortA: { before: metrics({ clicks: 40 }), after: metrics({ clicks: 12 }) }, // 12 < 30
        cohortB: { before: metrics({ clicks: 200 }), after: metrics({ clicks: 100 }) },
        enoughData: false,
      },
    })
    expect(block).toContain('ЭФФЕКТ ПЕРВОЙ ПОРЦИИ')
    expect(block).toContain('данных мало')
    expect(block).toContain('Когорта A (поднятые)')
    expect(block).toContain('Когорта B (остальной портфель)')
    expect(block).not.toContain('решает владелец') // вывода нет, пока мало данных
  })

  it('данных достаточно → цифры + арбитр (решает владелец), без авто-решения', () => {
    const block = buildWeeklyDataBlock(days, {
      ...base,
      cohortEffect: {
        raiseDay: '2026-07-10',
        cohortA: { before: metrics({ clicks: 40, spendRub: 4000 }), after: metrics({ clicks: 60, spendRub: 6600 }) },
        cohortB: { before: metrics({ clicks: 200 }), after: metrics({ clicks: 210 }) },
        enoughData: true,
      },
    })
    expect(block).toContain('цена клика 110 ₽') // 6600/60
    expect(block).toContain('решает владелец')
  })

  it('cohortEffect не задан → блока нет', () => {
    expect(buildWeeklyDataBlock(days, base)).not.toContain('ЭФФЕКТ ПЕРВОЙ ПОРЦИИ')
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
    // обычный CPC (50 ₽) — без пометки надбавки
    expect(block).not.toContain('алгоритмическая надбавка')
  })

  // ШАГ 2: счётчик отсеянных дублей-ретраев заявок в дневной сводке.
  it('dedupDroppedToday > 0 → строка про отсеянные дубли', () => {
    const block = buildDailyDataBlock(dailyInput({ dedupDroppedToday: 3 }))
    expect(block).toContain('Дублей-ретраев заявок отсеяно за сегодня: 3')
  })

  it('dedupDroppedToday 0/undefined → строки нет (не сорим нулями)', () => {
    expect(buildDailyDataBlock(dailyInput({ dedupDroppedToday: 0 }))).not.toContain(
      'Дублей-ретраев'
    )
    expect(buildDailyDataBlock(dailyInput())).not.toContain('Дублей-ретраев')
  })

  // ШАГ 4: списание выше потолка назначаемых ставок (400 ₽) → пометка надбавки.
  it('CPC выше потолка + конверсия → «алгоритмическая надбавка (дорого, но конвертит)»', () => {
    const block = buildDailyDataBlock(
      dailyInput({
        data: day({
          topQueries: [{ query: 'кейтеринг', clicks: 1, costRub: 1275.98, conversions: 1 }],
        }),
      })
    )
    expect(block).toContain('алгоритмическая надбавка (дорого, но конвертит)')
  })

  it('CPC выше потолка без конверсии → «алгоритмическая надбавка (наблюдаю, не баг данных)»', () => {
    const block = buildDailyDataBlock(
      dailyInput({
        data: day({
          topQueries: [{ query: 'кейтеринг', clicks: 2, costRub: 1200, conversions: 0 }],
        }),
      })
    )
    expect(block).toContain('алгоритмическая надбавка (наблюдаю, не баг данных)')
  })

  it('CPC на потолке/ниже (≤400 ₽) → без пометки надбавки', () => {
    const block = buildDailyDataBlock(
      dailyInput({
        data: day({
          topQueries: [{ query: 'обеды', clicks: 10, costRub: 4000, conversions: 1 }],
        }),
      })
    )
    expect(block).not.toContain('алгоритмическая надбавка')
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
    // ШАГ 4: в дневной пересказ теперь подмешана справочная доктрина (в т.ч. про
    // алгоритмическую надбавку), поэтому system = базовый промпт + блок доктрины.
    expect(call.system).toContain('SYSTEM_PROMPT')
    expect(call.system).toContain('ДОКТРИНА')
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
    expect(block).toContain('Средняя цена заявки (расход / доставлено из Директа): 1000 ₽') // 3000 / 3 — код, не LLM
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
    expect(block).toContain('Средняя цена заявки (расход / доставлено из Директа): нет данных')
  })

  it('регресс 13.07: расход 9551 / доставлено из Директа 4 → CPA 2388 ₽ с подписью методики', () => {
    const days = [day({ dateLabel: '2026-07-06', spendRub: 9551, leadsFromDirect: 4, leadsTotal: 4 })]
    const block = buildWeeklyDataBlock(days, { llmSpendUsd: 0, llmCalls: 0, proposalsPending: 0 })
    expect(block).toContain('Средняя цена заявки (расход / доставлено из Директа): 2388 ₽')
  })

  it('М3: underspendWeekly → строка недорасхода + оценка упущенного объёма при медиане < 80%', () => {
    const block = buildWeeklyDataBlock(days, {
      llmSpendUsd: 0, llmCalls: 0, proposalsPending: 0,
      underspendWeekly: { medianSpendRub: 1000, dailyBudgetRub: 3000 }, // 33% < 80% → систематический
    })
    expect(block).toContain('Недорасход: медиана 1000 ₽/день из 3000 ₽ (33%)')
    expect(block).toContain('кликов/день упущено') // грубая оценка объёма
    // Медиана у нормы (85%) → строка недорасхода есть, но оценки упущенного НЕТ.
    const nearNorm = buildWeeklyDataBlock(days, {
      llmSpendUsd: 0, llmCalls: 0, proposalsPending: 0,
      underspendWeekly: { medianSpendRub: 2550, dailyBudgetRub: 3000 },
    })
    expect(nearNorm).toContain('Недорасход: медиана 2550')
    expect(nearNorm).not.toContain('упущено')
  })

  it('М2: matchTypeShare → строка «доля SYNONYM-трафика N%» (видимость); нет → строки нет', () => {
    const withShare = buildWeeklyDataBlock(days, {
      llmSpendUsd: 0, llmCalls: 0, proposalsPending: 0,
      matchTypeShare: { synonymPct: 61.4, synonymClicks: 35, keywordClicks: 22 },
    })
    expect(withShare).toContain('Доля SYNONYM-трафика: 61% (35 синонимных кликов из 57)')

    const without = buildWeeklyDataBlock(days, { llmSpendUsd: 0, llmCalls: 0, proposalsPending: 0 })
    expect(without).not.toContain('SYNONYM')
  })

  it('ШАГ 4: leadCounts → три счётчика + различия + оговорка о слепой БД + явный период', () => {
    const block = buildWeeklyDataBlock(days, {
      llmSpendUsd: 0,
      llmCalls: 0,
      proposalsPending: 0,
      period: { from: '2026-06-30', to: '2026-07-05' },
      leadCounts: { directAttrib: 3, metrika: 6, delivered: 1, deliveredBlindBefore: '2026-07-04' },
    })
    expect(block).toContain('период 30.06–05.07')
    expect(block).toContain('Директ-атрибуция (клик→цель, отчёт Директа): 3')
    expect(block).toContain('Метрика (достижения цели 575665118): 6')
    expect(block).toContain('Доставлено (в чат/БД LandingLead): 1')
    expect(block).toContain('Различия:') // 6>1 и 6>3 → строка о различиях
    expect(block).toContain('БД LandingLead слепа до 04.07')
    // старой одиночной строки быть не должно, когда есть три счётчика
    expect(block).not.toContain('Заявок всего:')
  })

  it('ШАГ 3а: конвертер в «худших» — только с оговоркой «КОНВЕРТЕР»', () => {
    const withConverter = [
      day({
        dateLabel: '2026-07-03',
        spendRub: 1276,
        clicks: 1,
        impressions: 7,
        topQueries: [
          { query: 'корпоративное питание с доставкой москва', clicks: 1, costRub: 1276, conversions: 0 },
        ],
      }),
    ]
    const block = buildWeeklyDataBlock(withConverter, { llmSpendUsd: 0, llmCalls: 0, proposalsPending: 0 })
    // фраза с 0 конверсий и большим расходом попала бы в «худшие», но она конвертер:
    expect(block).toContain('корпоративное питание с доставкой москва')
    expect(block).toContain('КОНВЕРТЕР (защищён, не режем)')
    // и она же перечислена в секции «под защитой»
    expect(block).toContain('КОНВЕРТЕРЫ ПОД ЗАЩИТОЙ')
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
