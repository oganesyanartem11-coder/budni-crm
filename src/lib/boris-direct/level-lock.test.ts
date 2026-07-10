import { describe, it, expect } from 'vitest'
import {
  resolveLevel,
  serializeLevels,
  deserializeLevels,
  type LockedLevel,
  type PhraseLevelMap,
} from './level-lock'

describe('resolveLevel — уровень меняется ТОЛЬКО при смене вердикта', () => {
  it('вердикт не сменился → tv ЗАМОРОЖЕН (не трогаем от дрейфа posterior/цен)', () => {
    const prev: LockedLevel = { verdict: 'promote', tv: 55 }
    // baseTv/uplift подсунуты другие — их игнорируем, держим prev.tv.
    const r = resolveLevel({ prev, verdict: 'promote', baseTv: 55, upliftTv: 80 })
    expect(r.tv).toBe(55)
    expect(r.changed).toBe(false)
    expect(r.lock).toEqual(prev)
  })

  it('смена вердикта promote→demote → уровень переустанавливается на baseTv', () => {
    const prev: LockedLevel = { verdict: 'promote', tv: 75 }
    const r = resolveLevel({ prev, verdict: 'demote', baseTv: 15 })
    expect(r.tv).toBe(15)
    expect(r.changed).toBe(true)
    expect(r.lock).toEqual({ verdict: 'demote', tv: 15 })
  })

  it('новая фраза (prev нет) → уровень устанавливается от вердикта (baseTv)', () => {
    const r = resolveLevel({ prev: undefined, verdict: 'promote', baseTv: 55 })
    expect(r.tv).toBe(55)
    expect(r.lock).toEqual({ verdict: 'promote', tv: 55 })
  })

  it('маржинальный подъём применяется В МОМЕНТ установки promote (upliftTv > baseTv)', () => {
    const r = resolveLevel({ prev: undefined, verdict: 'promote', baseTv: 55, upliftTv: 80 })
    expect(r.tv).toBe(80)
    expect(r.lock).toEqual({ verdict: 'promote', tv: 80 })
  })

  it('для demote надбавка игнорируется (подъём только на promote)', () => {
    const r = resolveLevel({ prev: undefined, verdict: 'demote', baseTv: 15, upliftTv: 80 })
    expect(r.tv).toBe(15)
  })

  it('надбавка НЕ прыгает: promote заморожен на 75, upliftTv=80 не поднимает (нет смены вердикта)', () => {
    const prev: LockedLevel = { verdict: 'promote', tv: 75 }
    const r = resolveLevel({ prev, verdict: 'promote', baseTv: 55, upliftTv: 80 })
    expect(r.tv).toBe(75) // остаётся замороженным, НЕ 80
  })

  it('upliftTv ≤ baseTv не понижает уровень (берём baseTv)', () => {
    const r = resolveLevel({ prev: undefined, verdict: 'promote', baseTv: 55, upliftTv: 55 })
    expect(r.tv).toBe(55)
    const r2 = resolveLevel({ prev: undefined, verdict: 'promote', baseTv: 55, upliftTv: 40 })
    expect(r2.tv).toBe(55)
  })
})

describe('serialize/deserialize уровней (персист в снапшоте, без миграций)', () => {
  it('round-trip сохраняет карту', () => {
    const m: PhraseLevelMap = new Map([
      [111, { verdict: 'promote', tv: 55 }],
      [222, { verdict: 'demote', tv: 15 }],
    ])
    const round = deserializeLevels(serializeLevels(m))
    expect(round.get(111)).toEqual({ verdict: 'promote', tv: 55 })
    expect(round.get(222)).toEqual({ verdict: 'demote', tv: 15 })
    expect(round.size).toBe(2)
  })

  it('пустой/нулевой payload → пустая карта (bootstrap, НЕ падение)', () => {
    expect(deserializeLevels(null).size).toBe(0)
    expect(deserializeLevels(undefined).size).toBe(0)
    expect(deserializeLevels({ levels: [] }).size).toBe(0)
  })

  it('мусорные записи отбрасываются (устойчивость к порче снапшота)', () => {
    const m = deserializeLevels({
      levels: [
        { keywordId: 1, verdict: 'promote', tv: 55 },
        // @ts-expect-error намеренно битая запись
        { keywordId: 'x', verdict: 'promote', tv: 55 },
        // @ts-expect-error намеренно битый вердикт
        { keywordId: 2, verdict: 'lol', tv: 15 },
      ],
    })
    expect(m.size).toBe(1)
    expect(m.get(1)).toEqual({ verdict: 'promote', tv: 55 })
  })
})
