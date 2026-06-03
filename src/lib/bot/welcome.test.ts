import { describe, it, expect } from 'vitest'
import {
  pickWelcomeKind,
  getWelcomeText,
  type WelcomeKind,
  type ClientForWelcome,
} from './welcome'

/**
 * Перепозиционирование MAX-канала (welcome от лица «менеджеров Будни»).
 * pickWelcomeKind ветвит по приоритету SAMEDAY > WEEKLY > DYNAMIC > FIXED;
 * getWelcomeText отдаёт согласованные тексты как есть.
 */

function client(
  mealConfigs: ClientForWelcome['mealConfigs'],
  locations: ClientForWelcome['locations']
): ClientForWelcome {
  return { mealConfigs, locations }
}

describe('pickWelcomeKind', () => {
  it('пустые mealConfigs и пустые locations → FIXED', () => {
    expect(pickWelcomeKind(client([], []))).toBe('FIXED')
  })

  it('один FIXED-конфиг, локация sameDayDelivery=false → FIXED', () => {
    expect(
      pickWelcomeKind(client([{ orderType: 'FIXED' }], [{ sameDayDelivery: false }]))
    ).toBe('FIXED')
  })

  it('один DYNAMIC-конфиг, все локации sameDayDelivery=false → DYNAMIC', () => {
    expect(
      pickWelcomeKind(
        client([{ orderType: 'DYNAMIC' }], [{ sameDayDelivery: false }, { sameDayDelivery: false }])
      )
    ).toBe('DYNAMIC')
  })

  it('любые конфиги, но одна локация sameDayDelivery=true → SAMEDAY (приоритет)', () => {
    expect(
      pickWelcomeKind(
        client(
          [{ orderType: 'FIXED' }, { orderType: 'DYNAMIC' }],
          [{ sameDayDelivery: false }, { sameDayDelivery: true }]
        )
      )
    ).toBe('SAMEDAY')
  })

  it('смешанные FIXED+DYNAMIC, без sameDay-локаций → DYNAMIC (DYNAMIC выигрывает у FIXED)', () => {
    expect(
      pickWelcomeKind(
        client([{ orderType: 'FIXED' }, { orderType: 'DYNAMIC' }], [{ sameDayDelivery: false }])
      )
    ).toBe('DYNAMIC')
  })

  it('один WEEKLY-конфиг, без sameDay-локаций → WEEKLY', () => {
    expect(
      pickWelcomeKind(client([{ orderType: 'WEEKLY' }], [{ sameDayDelivery: false }]))
    ).toBe('WEEKLY')
  })

  it('WEEKLY-конфиг + локация sameDayDelivery=true → SAMEDAY (приоритет)', () => {
    expect(
      pickWelcomeKind(
        client(
          [{ orderType: 'WEEKLY' }],
          [{ sameDayDelivery: false }, { sameDayDelivery: true }]
        )
      )
    ).toBe('SAMEDAY')
  })

  it('смешанные WEEKLY+DYNAMIC, без sameDay-локаций → WEEKLY (WEEKLY выигрывает у DYNAMIC)', () => {
    expect(
      pickWelcomeKind(
        client([{ orderType: 'DYNAMIC' }, { orderType: 'WEEKLY' }], [{ sameDayDelivery: false }])
      )
    ).toBe('WEEKLY')
  })
})

describe('getWelcomeText', () => {
  const kinds: WelcomeKind[] = ['FIXED', 'DYNAMIC', 'SAMEDAY', 'WEEKLY']

  it.each(kinds)('начинается с «Здравствуйте! Это Будни.» (%s)', (kind) => {
    expect(getWelcomeText(kind).startsWith('Здравствуйте! Это Будни.')).toBe(true)
  })

  it.each(kinds)('заканчивается подписью «— Будни» (%s)', (kind) => {
    expect(getWelcomeText(kind).trimEnd().endsWith('— Будни')).toBe(true)
  })

  it('SAMEDAY содержит 07:40 и 08:40', () => {
    const text = getWelcomeText('SAMEDAY')
    expect(text).toContain('07:40')
    expect(text).toContain('08:40')
  })

  it('DYNAMIC содержит 11:00 и 16:00', () => {
    const text = getWelcomeText('DYNAMIC')
    expect(text).toContain('11:00')
    expect(text).toContain('16:00')
  })

  it('FIXED содержит «до 16:00 накануне»', () => {
    expect(getWelcomeText('FIXED')).toContain('до 16:00 накануне')
  })

  it('WEEKLY начинается с «Здравствуйте! Это Будни.», содержит «следующую неделю» и заканчивается «— Будни»', () => {
    const text = getWelcomeText('WEEKLY')
    expect(text.startsWith('Здравствуйте! Это Будни.')).toBe(true)
    expect(text).toContain('следующую неделю')
    expect(text.trimEnd().endsWith('— Будни')).toBe(true)
  })
})
