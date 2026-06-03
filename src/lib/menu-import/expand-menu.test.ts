import { describe, it, expect } from 'vitest'
import { pickWeekForIndex, type MenuImportStructure, type WeekStructure } from './expand-menu'

/**
 * Sprint 8.x: третья неделя меню (А→Б→В). pickWeekForIndex — чистая ротация
 * по числу определённых недель (cycleLen). Backward compat для 2-недельных
 * импортов: при weekC=null поведение прежнее (i % 2, метки А/Б).
 */

// Уникальные маркеры недель, чтобы различать какую вернула ротация.
const A: WeekStructure = { days: [{ dayOfWeek: 1, mealType: 'LUNCH', dishes: [{ dishId: 'a', slotCategory: 'MAIN' }] }] }
const B: WeekStructure = { days: [{ dayOfWeek: 1, mealType: 'LUNCH', dishes: [{ dishId: 'b', slotCategory: 'MAIN' }] }] }
const C: WeekStructure = { days: [{ dayOfWeek: 1, mealType: 'LUNCH', dishes: [{ dishId: 'c', slotCategory: 'MAIN' }] }] }

const struct = (weekA: WeekStructure | null, weekB: WeekStructure | null, weekC: WeekStructure | null): MenuImportStructure =>
  ({ weekA: weekA as WeekStructure, weekB, weekC })

describe('pickWeekForIndex — 1 неделя (только A)', () => {
  const s = struct(A, null, null)
  it('любой i и startOffset → idx=0, label А', () => {
    for (const i of [0, 1, 2, 5, 13]) {
      expect(pickWeekForIndex(s, i)).toMatchObject({ idx: 0, label: 'А', week: A })
    }
    expect(pickWeekForIndex(s, 0, 1)).toMatchObject({ idx: 0, label: 'А' })
    expect(pickWeekForIndex(s, 7, 2)).toMatchObject({ idx: 0, label: 'А' })
  })
})

describe('pickWeekForIndex — 2 недели (A+B), backward compat', () => {
  const s = struct(A, B, null)
  it('startOffset=0: чередование A/Б (i % 2)', () => {
    expect(pickWeekForIndex(s, 0).label).toBe('А')
    expect(pickWeekForIndex(s, 1).label).toBe('Б')
    expect(pickWeekForIndex(s, 2).label).toBe('А')
    expect(pickWeekForIndex(s, 3).label).toBe('Б')
  })
  it('startOffset=1: смещение на Б', () => {
    expect(pickWeekForIndex(s, 0, 1).label).toBe('Б')
    expect(pickWeekForIndex(s, 1, 1).label).toBe('А')
    expect(pickWeekForIndex(s, 2, 1).label).toBe('Б')
  })
  it('возвращает правильный week-объект', () => {
    expect(pickWeekForIndex(s, 0).week).toBe(A)
    expect(pickWeekForIndex(s, 1).week).toBe(B)
  })
})

describe('pickWeekForIndex — 3 недели (A+B+C)', () => {
  const s = struct(A, B, C)
  it('startOffset=0: чередование А/Б/В (i % 3)', () => {
    expect(pickWeekForIndex(s, 0)).toMatchObject({ idx: 0, label: 'А', week: A })
    expect(pickWeekForIndex(s, 1)).toMatchObject({ idx: 1, label: 'Б', week: B })
    expect(pickWeekForIndex(s, 2)).toMatchObject({ idx: 2, label: 'В', week: C })
    expect(pickWeekForIndex(s, 3).label).toBe('А')
    expect(pickWeekForIndex(s, 4).label).toBe('Б')
  })
  it('startOffset=2: смещение на В', () => {
    expect(pickWeekForIndex(s, 0, 2).label).toBe('В')
    expect(pickWeekForIndex(s, 1, 2).label).toBe('А')
    expect(pickWeekForIndex(s, 2, 2).label).toBe('Б')
  })
})

describe('pickWeekForIndex — edge cases', () => {
  it('пустая структура (weekA=null) бросает Error', () => {
    const empty = struct(null, null, null)
    expect(() => pickWeekForIndex(empty, 0)).toThrow(/empty structure/)
  })

  it('backward compat: weekC=null идентичен старому i % 2', () => {
    const s = struct(A, B, null)
    for (let i = 0; i < 13; i++) {
      const expected = i % 2 === 0 ? 'А' : 'Б'
      expect(pickWeekForIndex(s, i).label).toBe(expected)
    }
  })
})
