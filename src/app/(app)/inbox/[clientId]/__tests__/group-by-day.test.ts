import { describe, it, expect } from 'vitest'
import {
  groupMessagesByMskDay,
  formatDayChipLabel,
  type DayGroupableMessage,
} from '../group-by-day'

// MSK = UTC+3 (без DST с 2011). Чтобы UTC-инстант попал в МСК-день D 12:00,
// берём UTC 09:00 того же дня. Граница суток: МСК 00:00 = UTC 21:00 пред. дня.

const msg = (iso: string): DayGroupableMessage & { id: string } => ({
  id: iso,
  createdAt: new Date(iso),
})

describe('groupMessagesByMskDay', () => {
  it('пустой список → []', () => {
    expect(groupMessagesByMskDay([])).toEqual([])
  })

  it('все сообщения одного МСК-дня → одна группа', () => {
    const groups = groupMessagesByMskDay([
      msg('2026-06-08T06:00:00Z'), // МСК 09:00 8 июня
      msg('2026-06-08T18:00:00Z'), // МСК 21:00 8 июня
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].dayKey).toBe('2026-06-08')
    expect(groups[0].messages).toHaveLength(2)
  })

  it('две даты на границе МСК-полуночи → 2 группы в порядке', () => {
    const groups = groupMessagesByMskDay([
      // UTC 20:59 7 июня = МСК 23:59 7 июня
      msg('2026-06-07T20:59:00Z'),
      // UTC 21:01 7 июня = МСК 00:01 8 июня
      msg('2026-06-07T21:01:00Z'),
    ])
    expect(groups.map((g) => g.dayKey)).toEqual(['2026-06-07', '2026-06-08'])
    expect(groups[0].messages).toHaveLength(1)
    expect(groups[1].messages).toHaveLength(1)
  })

  it('сохраняет порядок сообщений внутри группы', () => {
    const a = msg('2026-06-08T06:00:00Z')
    const b = msg('2026-06-08T07:00:00Z')
    const groups = groupMessagesByMskDay([a, b])
    expect(groups[0].messages.map((m) => (m as { id: string }).id)).toEqual([a.id, b.id])
  })
})

describe('formatDayChipLabel', () => {
  // «сейчас» = МСК 8 июня 2026 12:00 (UTC 09:00).
  const nowMsk = new Date('2026-06-08T09:00:00Z')

  it('сегодняшний МСК-день → «Сегодня»', () => {
    expect(formatDayChipLabel('2026-06-08', nowMsk)).toBe('Сегодня')
  })

  it('вчерашний МСК-день → «Вчера»', () => {
    expect(formatDayChipLabel('2026-06-07', nowMsk)).toBe('Вчера')
  })

  it('тот же год, не сегодня/вчера → «6 июня»', () => {
    expect(formatDayChipLabel('2026-06-06', nowMsk)).toBe('6 июня')
  })

  it('другой год → «6 июня 2025»', () => {
    expect(formatDayChipLabel('2025-06-06', nowMsk)).toBe('6 июня 2025')
  })

  it('родительный падеж месяца (январь → января)', () => {
    expect(formatDayChipLabel('2026-01-15', nowMsk)).toBe('15 января')
  })

  it('«вчера» корректно через границу месяца', () => {
    // сейчас = МСК 1 июня 2026; вчера = 31 мая
    const now = new Date('2026-06-01T09:00:00Z')
    expect(formatDayChipLabel('2026-05-31', now)).toBe('Вчера')
    expect(formatDayChipLabel('2026-06-01', now)).toBe('Сегодня')
  })
})
