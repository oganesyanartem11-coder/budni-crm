import { describe, it, expect } from 'vitest'
import { cpcCeilingRub, auditCpc } from './cpc-audit'
import { BID_CEILING_MICRO, MICRO, CPC_OVER_CEILING_VAT, CPC_OVER_CEILING_MARGIN } from './config'

describe('cpcCeilingRub', () => {
  it('порог = потолок ставки × НДС × запас', () => {
    const expected = (BID_CEILING_MICRO / MICRO) * CPC_OVER_CEILING_VAT * CPC_OVER_CEILING_MARGIN
    expect(cpcCeilingRub()).toBeCloseTo(expected, 5)
    expect(cpcCeilingRub()).toBeCloseTo(528, 5) // 400 × 1.2 × 1.1
  })
})

describe('auditCpc', () => {
  it('РЕПЛЕЙ: клик 831 ₽ (12.07) обязан загореться', () => {
    const rows = [
      { key: 'питание в офисы', clicks: 1, costRub: 831, date: '2026-07-12' },
      { key: 'доставка обедов', clicks: 2, costRub: 300, date: '2026-07-12' }, // cpc 150 < порога
    ]
    const out = auditCpc(rows)
    expect(out.over).toHaveLength(1)
    expect(out.over[0].key).toBe('питание в офисы')
    expect(out.over[0].cpcRub).toBe(831)
    expect(out.overCount).toBe(1)
    expect(out.alert).not.toBeNull()
    expect(out.alert!.severity).toBe('critical')
    expect(out.alert!.text).toMatch(/831/)
    expect(out.alert!.kind).toBe('cpc_over_ceiling')
  })

  it('средний CPC выше порога у многокликовой фразы тоже ловится', () => {
    // 3 клика, 1800 ₽ → cpc 600 > 528.
    const out = auditCpc([{ key: 'дорогая', clicks: 3, costRub: 1800, date: '2026-07-13' }])
    expect(out.overCount).toBe(1)
    expect(out.over[0].cpcRub).toBe(600)
  })

  it('лишние ₽ = сумма списанного сверх потолка С НДС (480 ₽), а не нетто 400', () => {
    const out = auditCpc([{ key: 'x', clicks: 1, costRub: 831, date: '2026-07-12' }])
    // cost из отчёта — с НДС; потолок 400 нетто → 480 с НДС. 831 − 480 = 351 ₽.
    expect(out.extraRub).toBe(351)
  })

  it('нулевой/пустой ввод — тишина', () => {
    expect(auditCpc([]).alert).toBeNull()
    expect(auditCpc([{ key: 'y', clicks: 0, costRub: 0, date: '2026-07-12' }]).over).toHaveLength(0)
  })

  it('клик под порогом не считается пробоем', () => {
    const out = auditCpc([{ key: 'норм', clicks: 1, costRub: 400, date: '2026-07-12' }])
    expect(out.overCount).toBe(0)
    expect(out.alert).toBeNull()
  })

  it('несколько нарушителей: сортировка по CPC убыв., сводка суммирует', () => {
    const out = auditCpc([
      { key: 'a', clicks: 1, costRub: 600, date: '2026-07-12' },
      { key: 'b', clicks: 1, costRub: 831, date: '2026-07-12' },
      { key: 'c', clicks: 1, costRub: 700, date: '2026-07-12' },
    ])
    expect(out.over.map((o) => o.key)).toEqual(['b', 'c', 'a'])
    expect(out.overCount).toBe(3)
    // extra (сверх 480 с НДС) = (600−480)+(831−480)+(700−480) = 120+351+220 = 691
    expect(out.extraRub).toBe(691)
    expect(out.alert!.text).toMatch(/691|3/)
  })
})
