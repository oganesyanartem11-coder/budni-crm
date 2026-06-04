import { describe, it, expect } from 'vitest'
import { formatUrgentAttention, buildExcerpt, countUncoveredPending } from './context-builder'

describe('formatUrgentAttention', () => {
  it('содержит ClientName, LocationName и tone в формате', () => {
    const desc = formatUrgentAttention({
      clientName: 'ООО Ромашка',
      locationName: 'Офис на Ленина',
      excerpt: 'Где наш обед?!',
      tone: 'urgent',
    })
    expect(desc).toContain('ООО Ромашка')
    expect(desc).toContain('Офис на Ленина')
    expect(desc).toContain('[tone=urgent]')
    expect(desc).toBe('От ООО Ромашка (Офис на Ленина): "Где наш обед?!" [tone=urgent]')
  })

  it('обрезает excerpt до 60 символов с «…» (обрезку делает buildExcerpt при формировании)', () => {
    // formatUrgentAttention получает уже готовый excerpt; проверяем, что
    // 60-символьный excerpt с многоточием встраивается без искажений.
    const sixtyPlusEllipsis = 'А'.repeat(60) + '…'
    const desc = formatUrgentAttention({
      clientName: 'Клиент',
      locationName: 'Точка',
      excerpt: sixtyPlusEllipsis,
      tone: 'rude',
    })
    expect(desc).toContain(sixtyPlusEllipsis)
    expect(desc).toBe(`От Клиент (Точка): "${sixtyPlusEllipsis}" [tone=rude]`)
    expect(desc).toContain('[tone=rude]')
  })

  it('фолбэк при пустом excerpt — без кривых пустых кавычек', () => {
    const desc = formatUrgentAttention({
      clientName: 'Стройка №3',
      locationName: 'Объект',
      excerpt: '',
      tone: 'urgent',
    })
    expect(desc).not.toContain('""')
    expect(desc).toBe('От Стройка №3 (Объект): срочное сообщение, сегодня доставка [tone=urgent]')
  })

  it('подставляет «—» если локация отсутствует', () => {
    const desc = formatUrgentAttention({
      clientName: 'Клиент',
      locationName: '',
      excerpt: 'текст',
      tone: 'rude',
    })
    expect(desc).toBe('От Клиент (—): "текст" [tone=rude]')
  })
})

describe('buildExcerpt', () => {
  it('обрезает сообщение до 60 символов и добавляет «…»', () => {
    const long = 'Я'.repeat(100)
    const ex = buildExcerpt(long, 60)
    expect(ex).toBe('Я'.repeat(60) + '…')
    // 60 символов + один символ многоточия.
    expect([...ex].length).toBe(61)
  })

  it('не добавляет «…» если сообщение короче лимита', () => {
    expect(buildExcerpt('коротко', 60)).toBe('коротко')
  })

  it('пустое/null сообщение → пустая строка', () => {
    expect(buildExcerpt(null, 60)).toBe('')
    expect(buildExcerpt(undefined, 60)).toBe('')
    expect(buildExcerpt('   ', 60)).toBe('')
  })
})

describe('countUncoveredPending (П3-механизм2: брифинг pending-дедуп)', () => {
  it('PENDING перекрыт CONFIRMED на тот же ключ → не считается', () => {
    const pending = [{ clientId: 'c1', locationId: 'l1', mealType: 'LUNCH' }]
    const covering = [{ clientId: 'c1', locationId: 'l1', mealType: 'LUNCH' }]
    expect(countUncoveredPending(pending, covering)).toBe(0)
  })

  it('PENDING без перекрытия → считается', () => {
    const pending = [{ clientId: 'c1', locationId: 'l1', mealType: 'LUNCH' }]
    const covering: { clientId: string; locationId: string; mealType: string }[] = []
    expect(countUncoveredPending(pending, covering)).toBe(1)
  })

  it('перекрытие только при полном совпадении ключа (отличие mealType → считается)', () => {
    const pending = [{ clientId: 'c1', locationId: 'l1', mealType: 'DINNER' }]
    // covering на тот же клиент+точку, но другой приём пищи — не перекрывает.
    const covering = [{ clientId: 'c1', locationId: 'l1', mealType: 'LUNCH' }]
    expect(countUncoveredPending(pending, covering)).toBe(1)
  })

  it('отличие locationId → не перекрывает, считается', () => {
    const pending = [{ clientId: 'c1', locationId: 'l1', mealType: 'LUNCH' }]
    const covering = [{ clientId: 'c1', locationId: 'l2', mealType: 'LUNCH' }]
    expect(countUncoveredPending(pending, covering)).toBe(1)
  })

  it('смешанный набор: часть перекрыта, часть нет → считаются только непокрытые', () => {
    const pending = [
      { clientId: 'c1', locationId: 'l1', mealType: 'LUNCH' }, // перекрыт
      { clientId: 'c2', locationId: 'l2', mealType: 'LUNCH' }, // НЕ перекрыт
      { clientId: 'c3', locationId: 'l3', mealType: 'DINNER' }, // НЕ перекрыт
    ]
    const covering = [
      { clientId: 'c1', locationId: 'l1', mealType: 'LUNCH' },
      { clientId: 'c3', locationId: 'l3', mealType: 'LUNCH' }, // другой mealType — не перекрывает c3/DINNER
    ]
    expect(countUncoveredPending(pending, covering)).toBe(2)
  })

  it('пустой pending → 0', () => {
    expect(countUncoveredPending([], [{ clientId: 'c1', locationId: 'l1', mealType: 'LUNCH' }])).toBe(0)
  })
})
