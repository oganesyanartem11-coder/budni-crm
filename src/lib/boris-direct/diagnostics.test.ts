import { describe, it, expect } from 'vitest'
import {
  minusPhraseBlocksQuery,
  weekdayOfMskDay,
  isWeekend,
  normalizeDevice,
  adjustedDeviceTypes,
  adjustedDemoSegments,
  canonicalizeDemoSegment,
  buildDemoSegments,
  diagnoseDeviceSkew,
  diagnoseScheduleWaste,
  aggregateWeekendStats,
  hasRealSchedule,
  diagnoseAudienceWaste,
  diagnoseGroupMinusGap,
  type DeviceRow,
} from './diagnostics'

// ---------- hasRealSchedule (воскрешение SCHEDULE_WASTE, спринт 14.07) ----------
// ИНВАРИАНТ ПОЛИГОНА: sim-фейк отдаёт TimeTargeting либо undefined, либо
// { Schedule: { Items: [] } }. Оба случая должны давать ТОТ ЖЕ результат, что
// старый `!!TimeTargeting` (undefined→false, {Items:[]}→true), иначе полигон
// дрогнет. 24/7-фикс срабатывает ТОЛЬКО на непустых all-100 Items (прод).
describe('hasRealSchedule', () => {
  const allHundred = (weekday: number) => `${weekday},` + Array(24).fill('100').join(',')

  it('нет TimeTargeting → false (расписания нет)', () => {
    expect(hasRealSchedule(undefined)).toBe(false)
    expect(hasRealSchedule(null)).toBe(false)
  })

  it('ИНВАРИАНТ sim: пустые Items → true (как старый !!TimeTargeting)', () => {
    expect(hasRealSchedule({ Schedule: { Items: [] } })).toBe(true)
    expect(hasRealSchedule({ Schedule: {} })).toBe(true)
    expect(hasRealSchedule({})).toBe(true)
  })

  it('ПРОД-ФИКС: все часы = 100 (24/7) → false (реального расписания нет)', () => {
    const items = [1, 2, 3, 4, 5, 6, 7].map(allHundred)
    expect(hasRealSchedule({ Schedule: { Items: items } })).toBe(false)
  })

  it('есть ограничение (хоть один час < 100) → true', () => {
    const items = ['1,100,100,0,0,' + Array(20).fill('100').join(','), allHundred(2)]
    expect(hasRealSchedule({ Schedule: { Items: items } })).toBe(true)
  })
})

// ---------- Общие хелперы ----------

describe('minusPhraseBlocksQuery', () => {
  it('минус блокирует запрос, если все его слова есть в запросе (операторы срезаются)', () => {
    expect(minusPhraseBlocksQuery('!для сотрудников', 'обеды для сотрудников офиса')).toBe(true)
    expect(minusPhraseBlocksQuery('казань', 'доставка обедов казань')).toBe(true)
    expect(minusPhraseBlocksQuery('"office"', 'coworking office lunch')).toBe(true)
  })
  it('не блокирует, если хотя бы одного слова минус-фразы нет в запросе', () => {
    expect(minusPhraseBlocksQuery('для сотрудников', 'обеды в офис')).toBe(false)
    expect(minusPhraseBlocksQuery('казань', 'доставка обедов москва')).toBe(false)
  })
  it('пустая минус-фраза ничего не блокирует', () => {
    expect(minusPhraseBlocksQuery('!!', 'что угодно')).toBe(false)
  })
})

describe('weekdayOfMskDay / isWeekend', () => {
  it('верный будень календарной даты (6 июля 2026 — понедельник)', () => {
    expect(weekdayOfMskDay('2026-07-06')).toBe(1) // Пн
    expect(weekdayOfMskDay('2026-07-11')).toBe(6) // Сб
    expect(weekdayOfMskDay('2026-07-12')).toBe(0) // Вс
  })
  it('выходные — суббота и воскресенье', () => {
    expect(isWeekend('2026-07-11')).toBe(true)
    expect(isWeekend('2026-07-12')).toBe(true)
    expect(isWeekend('2026-07-10')).toBe(false)
  })
})

describe('normalizeDevice / adjustedDeviceTypes', () => {
  it('нормализует метки устройств', () => {
    expect(normalizeDevice('PC')).toBe('DESKTOP')
    expect(normalizeDevice('Smartphones')).toBe('MOBILE')
    expect(normalizeDevice('Tablets')).toBe('TABLET')
  })
  it('собирает множество устройств с корректировкой', () => {
    const s = adjustedDeviceTypes([{ Type: 'DESKTOP_ONLY_ADJUSTMENT' }, { Type: 'MOBILE_ADJUSTMENT' }])
    expect(s.has('DESKTOP')).toBe(true)
    expect(s.has('MOBILE')).toBe(true)
    expect(s.has('TABLET')).toBe(false)
  })
})

// ---------- DEVICE_SKEW ----------

describe('diagnoseDeviceSkew', () => {
  const rows: DeviceRow[] = [
    { device: 'DESKTOP', clicks: 40, conversions: 3, costRub: 3600 },
    { device: 'MOBILE', clicks: 25, conversions: 0, costRub: 1670, costEstimated: true },
  ]
  it('флагает неконвертящее устройство с объёмом и без корректировки', () => {
    const out = diagnoseDeviceSkew(rows, new Set(['DESKTOP']))
    expect(out?.decision.reasonCode).toBe('DEVICE_SKEW')
    expect(out?.decision.factors.device).toBe('MOBILE')
    expect(out?.proposal.type).toBe('device_skew')
    expect(out?.proposal.topicKey).toBe('device_skew:MOBILE')
    expect(out?.proposal.argument).toMatch(/жду добро/)
  })
  it('молчит, если на устройстве уже есть корректировка', () => {
    expect(diagnoseDeviceSkew(rows, new Set(['DESKTOP', 'MOBILE']))).toBeNull()
  })
  it('молчит при малом объёме кликов на устройстве (шум)', () => {
    const low: DeviceRow[] = [
      { device: 'DESKTOP', clicks: 40, conversions: 3, costRub: 3600 },
      { device: 'MOBILE', clicks: 5, conversions: 0, costRub: 300 },
    ]
    expect(diagnoseDeviceSkew(low, new Set(['DESKTOP']))).toBeNull()
  })
  it('молчит, если никто не конвертит (вопрос не к устройствам)', () => {
    const none: DeviceRow[] = [
      { device: 'DESKTOP', clicks: 40, conversions: 0, costRub: 3600 },
      { device: 'MOBILE', clicks: 25, conversions: 0, costRub: 1670 },
    ]
    expect(diagnoseDeviceSkew(none, new Set())).toBeNull()
  })
})

// ---------- SCHEDULE_WASTE ----------

describe('aggregateWeekendStats — ФАКТ-приоритет доставленных заявок (BUG 2, 16.07)', () => {
  it('выходной с доставленной заявкой, но отчёт 0 → день сконвертил (диагноз не горит ложно)', () => {
    const rows = [
      { day: '2026-07-04', costRub: 2000, conversions: 0 }, // сб
      { day: '2026-07-05', costRub: 2634.35, conversions: 0 }, // вс — отчёт 0, но заявка была
    ]
    const agg = aggregateWeekendStats(rows, new Map([['2026-07-05', 1]]))
    expect(agg.weekendConversions).toBe(1) // из доставленной заявки, НЕ 0
    expect(agg.weekendDays).toBe(2)
    expect(Math.round(agg.weekendSpendRub)).toBe(4634)
    // Диагноз с этим счётом НЕ горит (заявка была).
    expect(diagnoseScheduleWaste({ ...agg, weekdayConversions: 5, hasSchedule: false })).toBeNull()
  })

  it('пустой deliveredByDay → как раньше (только отчёт): полигон-нейтрально', () => {
    const rows = [
      { day: '2026-07-04', costRub: 2000, conversions: 0 },
      { day: '2026-07-05', costRub: 2634.35, conversions: 0 },
    ]
    const agg = aggregateWeekendStats(rows, new Map())
    expect(agg.weekendConversions).toBe(0) // без доставленных заявок — прежнее поведение
  })

  it('заявки БУДНЕЙ не влияют на weekendConversions', () => {
    const agg = aggregateWeekendStats(
      [{ day: '2026-07-06', costRub: 1000, conversions: 2 }], // пн
      new Map([['2026-07-06', 5]])
    )
    expect(agg.weekendConversions).toBe(0)
    expect(agg.weekdayConversions).toBe(2)
  })

  it('max(отчёт, доставленные): отчёт уже посчитал → не задваиваем', () => {
    const agg = aggregateWeekendStats(
      [{ day: '2026-07-05', costRub: 500, conversions: 1 }],
      new Map([['2026-07-05', 1]])
    )
    expect(agg.weekendConversions).toBe(1) // max(1,1)=1, не 2
  })
})

describe('diagnoseScheduleWaste', () => {
  const base = {
    weekendSpendRub: 800,
    weekendConversions: 0,
    weekendDays: 4,
    weekdayConversions: 5,
    hasSchedule: false,
  }
  it('флагает пустой расход выходных при отсутствии расписания', () => {
    const out = diagnoseScheduleWaste(base)
    expect(out?.decision.reasonCode).toBe('SCHEDULE_WASTE')
    expect(out?.proposal.topicKey).toBe('schedule_waste')
    expect(out?.proposal.argument).toMatch(/B2B/)
  })
  it('молчит, если расписание уже настроено', () => {
    expect(diagnoseScheduleWaste({ ...base, hasSchedule: true })).toBeNull()
  })
  it('молчит при малом расходе выходных', () => {
    expect(diagnoseScheduleWaste({ ...base, weekendSpendRub: 100 })).toBeNull()
  })
  it('молчит, если по выходным ЕСТЬ заявки', () => {
    expect(diagnoseScheduleWaste({ ...base, weekendConversions: 1 })).toBeNull()
  })
  it('молчит, если и будни без заявок (проблема не в расписании)', () => {
    expect(diagnoseScheduleWaste({ ...base, weekdayConversions: 0 })).toBeNull()
  })
})

// ---------- AUDIENCE_WASTE ----------

describe('diagnoseAudienceWaste', () => {
  it('флагает демо-сегмент с объёмом и нулём заявок', () => {
    const segs = buildDemoSegments([
      { gender: 'male', age: '45-54', visits: 50, goalReaches: 0 },
      { gender: 'female', age: '25-34', visits: 30, goalReaches: 3 },
    ])
    const out = diagnoseAudienceWaste(segs, 3, new Set())
    expect(out?.decision.reasonCode).toBe('AUDIENCE_WASTE')
    expect(out?.proposal.argument).toMatch(/жду добро/)
  })
  it('молчит при малом объёме визитов сегмента', () => {
    const segs = buildDemoSegments([{ gender: 'male', age: '45-54', visits: 10, goalReaches: 0 }])
    expect(diagnoseAudienceWaste(segs, 3, new Set())).toBeNull()
  })
  it('молчит, если кампания в целом не конвертит', () => {
    const segs = buildDemoSegments([{ gender: 'male', age: '45-54', visits: 50, goalReaches: 0 }])
    expect(diagnoseAudienceWaste(segs, 0, new Set())).toBeNull()
  })
  it('НЕ предлагает сегмент, у которого УЖЕ есть демо-корректировка (Директ↔Метрика по канону)', () => {
    // Единственный дренаж — gender:male (male не конвертит, female и возраст 25-34 — да).
    // Метрика-метка 'gender:male' vs Директ-энум GENDER_MALE — оба к канону gender:male.
    const segs = buildDemoSegments([
      { gender: 'male', age: '25-34', visits: 50, goalReaches: 0 },
      { gender: 'female', age: '25-34', visits: 30, goalReaches: 3 },
    ])
    const adjusted = adjustedDemoSegments([{ DemographicsAdjustment: { Gender: 'GENDER_MALE' } }])
    expect(diagnoseAudienceWaste(segs, 3, adjusted)).toBeNull()
  })
})

describe('canonicalizeDemoSegment / adjustedDemoSegments (сверка Директ↔Метрика)', () => {
  it('пол: female/GENDER_FEMALE → gender:female; male/GENDER_MALE → gender:male', () => {
    expect(canonicalizeDemoSegment('gender:female')).toBe('gender:female')
    expect(canonicalizeDemoSegment('GENDER_FEMALE')).toBe('gender:female')
    expect(canonicalizeDemoSegment('gender:male')).toBe('gender:male')
    expect(canonicalizeDemoSegment('GENDER_MALE')).toBe('gender:male')
  })
  it('возраст: Метрика «Age 25‑34» (неразрывный дефис) и Директ AGE_25_34 → age:25-34; 55+ → age:55+', () => {
    expect(canonicalizeDemoSegment('age:Age 25‑34')).toBe('age:25-34')
    expect(canonicalizeDemoSegment('AGE_25_34')).toBe('age:25-34')
    expect(canonicalizeDemoSegment('age:Age 55+')).toBe('age:55+')
  })
  it('adjustedDemoSegments: собирает канон-ключи Age/Gender из корректировок', () => {
    const s = adjustedDemoSegments([
      { DemographicsAdjustment: { Gender: 'GENDER_MALE' } },
      { DemographicsAdjustment: { Age: 'AGE_25_34' } },
      { DemographicsAdjustment: {} },
      {},
    ])
    expect(s).toEqual(new Set(['gender:male', 'age:25-34']))
  })
})

// ---------- GROUP_MINUS_GAP ----------

describe('diagnoseGroupMinusGap', () => {
  const converting = [
    { query: 'обеды для сотрудников офиса', adGroupId: 'G8', adGroupName: 'G8 Сотрудники', clicks: 12, conversions: 2 },
    { query: 'доставка обедов в офис', adGroupId: 'G2', adGroupName: 'G2 Офис', clicks: 8, conversions: 1 },
  ]
  it('флагает минус кампании, задевающий конвертящий запрос группы', () => {
    const out = diagnoseGroupMinusGap(['!для сотрудников'], converting)
    expect(out).toHaveLength(1)
    expect(out[0].decision.reasonCode).toBe('GROUP_MINUS_GAP')
    expect(out[0].decision.targetId).toBe('G8')
    expect(out[0].proposal.topicKey).toBe('group_minus_gap:!для сотрудников')
  })
  it('не флагает минус, не задевающий конвертящие запросы', () => {
    expect(diagnoseGroupMinusGap(['казань'], converting)).toHaveLength(0)
  })
  it('игнорирует запросы ниже порога кликов/заявок', () => {
    const weak = [{ query: 'обеды для сотрудников', adGroupId: 'G8', clicks: 1, conversions: 1 }]
    expect(diagnoseGroupMinusGap(['!для сотрудников'], weak)).toHaveLength(0)
  })
})
