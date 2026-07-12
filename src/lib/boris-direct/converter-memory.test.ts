import { describe, it, expect } from 'vitest'
import {
  updateConverterMemory,
  activeConverterIds,
  converterMemoryLessonsForContext,
  type ConverterMemory,
} from './converter-memory'
import { CONVERTER_STALE_WINDOWS, PHRASE_MIN_CLICKS } from './config'

const TODAY = '2026-07-10'
const liveIds = new Set([11, 22, 33])

function win(criterionId: number, phrase: string, clicks: number, conversions: number) {
  return { criterionId, phrase, clicks, conversions }
}

describe('updateConverterMemory — вход по конверсии', () => {
  it('живой ключ с ≥1 конверсией в окне → запись ACTIVE, дата, evidence', () => {
    const next = updateConverterMemory({
      prev: {},
      window: [win(11, 'доставка обедов в офис', 40, 2)],
      todayMsk: TODAY,
      liveIds,
    })
    expect(next['11']).toMatchObject({
      criterionId: 11,
      status: 'ACTIVE',
      activatedMsk: TODAY,
      lastConversionMsk: TODAY,
      conversions: 2,
      emptyWindows: 0,
    })
  })

  it('0 конверсий и НЕТ прежней записи → ничего не создаём (запись только по конверсии)', () => {
    const next = updateConverterMemory({
      prev: {},
      window: [win(11, 'x', 100, 0)],
      todayMsk: TODAY,
      liveIds,
    })
    expect(next['11']).toBeUndefined()
  })
})

describe('updateConverterMemory — храповик STALE', () => {
  const active: ConverterMemory = {
    '11': { criterionId: 11, phrase: 'доставка обедов в офис', status: 'ACTIVE', activatedMsk: '2026-06-01', lastConversionMsk: '2026-06-20', conversions: 3, emptyWindows: 0 },
  }

  it('ACTIVE, 0 конверсий, кликов ≥ порога → счётчик пустых окон +1, ещё ACTIVE', () => {
    const next = updateConverterMemory({
      prev: active,
      window: [win(11, 'доставка обедов в офис', PHRASE_MIN_CLICKS + 5, 0)],
      todayMsk: TODAY,
      liveIds,
    })
    expect(next['11'].emptyWindows).toBe(1)
    expect(next['11'].status).toBe('ACTIVE')
  })

  it('CONVERTER_STALE_WINDOWS полных пустых окон подряд → STALE (защита снята)', () => {
    let mem = active
    for (let i = 0; i < CONVERTER_STALE_WINDOWS; i++) {
      mem = updateConverterMemory({
        prev: mem,
        window: [win(11, 'доставка обедов в офис', PHRASE_MIN_CLICKS + 1, 0)],
        todayMsk: TODAY,
        liveIds,
      })
    }
    expect(mem['11'].emptyWindows).toBe(CONVERTER_STALE_WINDOWS)
    expect(mem['11'].status).toBe('STALE')
  })

  it('ACTIVE, 0 конверсий, но кликов МАЛО (< порога) → окно не полное, храповик НЕ тикает', () => {
    const next = updateConverterMemory({
      prev: active,
      window: [win(11, 'доставка обедов в офис', PHRASE_MIN_CLICKS - 1, 0)],
      todayMsk: TODAY,
      liveIds,
    })
    expect(next['11'].emptyWindows).toBe(0)
    expect(next['11'].status).toBe('ACTIVE')
  })

  it('STALE запись + новая конверсия → снова ACTIVE, счётчик сброшен, история сохранена', () => {
    const stale: ConverterMemory = {
      '11': { criterionId: 11, phrase: 'доставка обедов в офис', status: 'STALE', activatedMsk: '2026-06-01', lastConversionMsk: '2026-06-20', conversions: 3, emptyWindows: CONVERTER_STALE_WINDOWS },
    }
    const next = updateConverterMemory({
      prev: stale,
      window: [win(11, 'доставка обедов в офис', 30, 1)],
      todayMsk: TODAY,
      liveIds,
    })
    expect(next['11'].status).toBe('ACTIVE')
    expect(next['11'].emptyWindows).toBe(0)
    expect(next['11'].lastConversionMsk).toBe(TODAY)
    expect(next['11'].activatedMsk).toBe('2026-06-01') // исходная активация сохранена
  })
})

describe('updateConverterMemory — прунинг мёртвых ключей', () => {
  it('запись по ключу вне liveIds отбрасывается', () => {
    const prev: ConverterMemory = {
      '99': { criterionId: 99, phrase: 'снятый ключ', status: 'ACTIVE', activatedMsk: '2026-06-01', lastConversionMsk: '2026-06-20', conversions: 2, emptyWindows: 0 },
    }
    const next = updateConverterMemory({ prev, window: [], todayMsk: TODAY, liveIds })
    expect(next['99']).toBeUndefined()
  })
})

describe('селекторы', () => {
  const mem: ConverterMemory = {
    '11': { criterionId: 11, phrase: 'доставка обедов в офис', status: 'ACTIVE', activatedMsk: '2026-06-01', lastConversionMsk: '2026-07-01', conversions: 2, emptyWindows: 0 },
    '22': { criterionId: 22, phrase: 'бизнес ланч', status: 'STALE', activatedMsk: '2026-06-01', lastConversionMsk: '2026-06-05', conversions: 1, emptyWindows: 3 },
  }

  it('activeConverterIds — только ACTIVE', () => {
    expect([...activeConverterIds(mem)]).toEqual([11])
  })

  it('converterMemoryLessonsForContext — только ACTIVE, форма урока с защитой', () => {
    const lessons = converterMemoryLessonsForContext(mem)
    expect(lessons).toHaveLength(1)
    expect(lessons[0].kind).toBe('converter')
    expect(lessons[0].text).toContain('доставка обедов в офис')
    expect(lessons[0].text.toLowerCase()).toContain('не минусовать')
  })
})
