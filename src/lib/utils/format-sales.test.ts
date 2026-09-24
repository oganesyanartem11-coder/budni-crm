import { describe, it, expect } from 'vitest'
import { formatMskDateTimeShort, formatDueRelative, formatAgoRu } from './format'

// now = 2026-09-24 14:00 МСК (четверг) = 11:00Z.
const NOW = new Date('2026-09-24T11:00:00.000Z')

describe('formatMskDateTimeShort', () => {
  it('«Пт, 25 сен 14:30» в МСК', () => {
    expect(formatMskDateTimeShort(new Date('2026-09-25T11:30:00.000Z'))).toBe('Пт, 25 сен 14:30')
  })
  it('поздний UTC-вечер — уже следующий МСК-день', () => {
    expect(formatMskDateTimeShort(new Date('2026-09-24T21:30:00.000Z'))).toBe('Пт, 25 сен 00:30')
  })
})

describe('formatDueRelative', () => {
  it('сегодня', () => {
    expect(formatDueRelative(new Date('2026-09-24T11:30:00.000Z'), NOW)).toBe('сегодня 14:30')
  })
  it('завтра', () => {
    expect(formatDueRelative(new Date('2026-09-25T07:00:00.000Z'), NOW)).toBe('завтра 10:00')
  })
  it('дальше завтра — полная дата', () => {
    expect(formatDueRelative(new Date('2026-09-28T07:00:00.000Z'), NOW)).toBe('Пн, 28 сен 10:00')
  })
  it('просрочено в минутах и часах', () => {
    expect(formatDueRelative(new Date('2026-09-24T10:20:00.000Z'), NOW)).toBe('просрочено 40 мин')
    expect(formatDueRelative(new Date('2026-09-24T09:00:00.000Z'), NOW)).toBe('просрочено 2 ч')
  })
  it('просрочено в днях', () => {
    expect(formatDueRelative(new Date('2026-09-21T11:00:00.000Z'), NOW)).toBe('просрочено 3 дн')
  })
  it('23:30 МСК → срок 00:30 МСК это «завтра», хотя по UTC тот же день', () => {
    const lateNow = new Date('2026-09-24T20:30:00.000Z')
    expect(formatDueRelative(new Date('2026-09-24T21:30:00.000Z'), lateNow)).toBe('завтра 00:30')
  })
})

describe('formatAgoRu', () => {
  it('минуты/часы/дни', () => {
    expect(formatAgoRu(new Date('2026-09-24T10:59:30.000Z'), NOW)).toBe('только что')
    expect(formatAgoRu(new Date('2026-09-24T10:55:00.000Z'), NOW)).toBe('5 мин назад')
    expect(formatAgoRu(new Date('2026-09-24T09:00:00.000Z'), NOW)).toBe('2 ч назад')
    expect(formatAgoRu(new Date('2026-09-21T11:00:00.000Z'), NOW)).toBe('3 дн назад')
  })
})
