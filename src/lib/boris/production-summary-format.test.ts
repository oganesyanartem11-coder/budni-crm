import { describe, it, expect } from 'vitest'
import { formatMoney } from '@/lib/utils/format'
import {
  formatProductionSummary,
  formatProductionSummaryRow,
  sortProductionSummaryRows,
  computeUnconfirmedConfigs,
} from './production-summary-format'

describe('formatProductionSummaryRow', () => {
  it('showLocation=false: «🏢 {Клиент} — N порций», без точки', () => {
    const row = formatProductionSummaryRow(
      {
        clientId: 'c1',
        clientName: 'Кофейня У Дома',
        locationId: 'l1',
        locationName: 'Тверская',
        portions: 12,
      },
      { showLocation: false }
    )
    expect(row).toBe('🏢 Кофейня У Дома — 12 порций')
    expect(row).toContain('🏢')
    expect(row).not.toContain('Тверская')
    expect(row).not.toContain('·')
  })

  it('showLocation=true: «🏢 {Клиент} · {Локация} — N порций» — клиент + точка', () => {
    const row = formatProductionSummaryRow(
      {
        clientId: 'c1',
        clientName: 'Сеть Кафе',
        locationId: 'l1',
        locationName: 'Арбат',
        portions: 1,
      },
      { showLocation: true }
    )
    expect(row).toBe('🏢 Сеть Кафе · Арбат — 1 порция')
    expect(row).toContain('🏢')
    expect(row).toContain('Сеть Кафе')
    expect(row).toContain('Арбат')
    expect(row).toContain('1 порция')
  })
})

describe('sortProductionSummaryRows', () => {
  it('сортирует по локации алфавитно, затем по клиенту', () => {
    const sorted = sortProductionSummaryRows([
      { clientId: 'b', clientName: 'Бета', locationId: 'l1', locationName: 'Тверская', portions: 5 },
      { clientId: 'g', clientName: 'Гамма', locationId: 'l2', locationName: 'Арбат', portions: 5 },
      { clientId: 'a', clientName: 'Альфа', locationId: 'l3', locationName: 'Арбат', portions: 5 },
    ])
    expect(sorted.map((r) => `${r.locationName}/${r.clientName}`)).toEqual([
      'Арбат/Альфа',
      'Арбат/Гамма',
      'Тверская/Бета',
    ])
  })
})

describe('formatProductionSummary', () => {
  it('шапка содержит итог «Завтра: N заказов, M порций, X ₽» и один эмодзи', () => {
    const text = formatProductionSummary({
      dateLabel: 'чт, 5 июня',
      orders: [
        { clientId: 'a', clientName: 'Альфа', locationId: 'l1', locationName: 'Арбат', portions: 10 },
        { clientId: 'b', clientName: 'Бета', locationId: 'l2', locationName: 'Тверская', portions: 5 },
      ],
      totalPortions: 15,
      totalRevenue: 12450,
    })
    expect(text).toContain(`Завтра: 2 заказа, 15 порций, ${formatMoney(12450)}`)
    // ровно один эмодзи в шапке (📋), без россыпи ✅/🔁 по строкам
    expect(text).toContain('📋')
    expect(text).not.toContain('✅')
    expect(text).not.toContain('🔁')
  })

  it('единый список заказов отсортирован по локации, затем по клиенту', () => {
    // У каждого клиента по одному заказу, но клиенты разные — каждый показан
    // строкой «🏢 {Клиент}». Сортировка идёт по локации, затем по клиенту.
    const text = formatProductionSummary({
      dateLabel: 'чт, 5 июня',
      orders: [
        { clientId: 'b', clientName: 'Бета', locationId: 'l2', locationName: 'Тверская', portions: 5 },
        { clientId: 'a', clientName: 'Альфа', locationId: 'l1', locationName: 'Арбат', portions: 10 },
      ],
      totalPortions: 15,
      totalRevenue: 1000,
    })
    const alpha = text.indexOf('🏢 Альфа')
    const beta = text.indexOf('🏢 Бета')
    expect(alpha).toBeGreaterThan(-1)
    expect(beta).toBeGreaterThan(-1)
    // Альфа на «Арбат» сортируется раньше Беты на «Тверская».
    expect(alpha).toBeLessThan(beta)
    // У каждого клиента ровно одна локация → точка не показывается.
    expect(text).not.toContain('Арбат')
    expect(text).not.toContain('Тверская')
  })

  it('клиент с 2 локациями: каждая строка «🏢 {Клиент} · {Локация} — N»', () => {
    const text = formatProductionSummary({
      dateLabel: 'чт, 5 июня',
      orders: [
        { clientId: 'a', clientName: 'Клиент-А', locationId: 'l1', locationName: 'Точка-1', portions: 8 },
        { clientId: 'a', clientName: 'Клиент-А', locationId: 'l2', locationName: 'Точка-2', portions: 4 },
      ],
      totalPortions: 12,
      totalRevenue: 5000,
    })
    expect(text).toContain('🏢 Клиент-А · Точка-1 — 8 порций')
    expect(text).toContain('🏢 Клиент-А · Точка-2 — 4 порции')
    expect(text).not.toContain('Подтверждено')
    expect(text).not.toContain('Фиксированные')
  })

  it('V-prodsum-locid: 2 РАЗНЫЕ точки одного клиента с ОДИНАКОВЫМ именем → обе показывают точку (дедуп по locationId, не по имени)', () => {
    const text = formatProductionSummary({
      dateLabel: 'чт, 5 июня',
      orders: [
        { clientId: 'c1', clientName: 'Клиент-А', locationId: 'l1', locationName: 'Склад', portions: 8 },
        { clientId: 'c1', clientName: 'Клиент-А', locationId: 'l2', locationName: 'Склад', portions: 4 },
      ],
      totalPortions: 12,
      totalRevenue: 5000,
    })
    // Две локации (по locationId) → showLocation сработал: символ « · » и имя точки
    // присутствуют, строки НЕ схлопнулись в одну «🏢 Клиент-А».
    expect(text).toContain('·')
    expect(text).toContain('🏢 Клиент-А · Склад — 8 порций')
    expect(text).toContain('🏢 Клиент-А · Склад — 4 порции')
    // Голой строки без точки быть не должно (иначе showLocation не сработал).
    expect(text).not.toContain('🏢 Клиент-А — ')
  })

  it('клиент с 1 локацией: строка «🏢 {Клиент} — N», точка опущена', () => {
    const text = formatProductionSummary({
      dateLabel: 'чт, 5 июня',
      orders: [
        { clientId: 'a', clientName: 'Клиент-А', locationId: 'l1', locationName: 'Точка-1', portions: 8 },
      ],
      totalPortions: 8,
      totalRevenue: 5000,
    })
    expect(text).toContain('🏢 Клиент-А — 8 порций')
    expect(text).not.toContain('Точка-1')
    expect(text).not.toContain('·')
  })

  it('решение one-vs-many считается per-client: один клиент с 2 точками + другой с 1', () => {
    const text = formatProductionSummary({
      dateLabel: 'чт, 5 июня',
      orders: [
        { clientId: 'multi', clientName: 'Мульти', locationId: 'l1', locationName: 'Север', portions: 3 },
        { clientId: 'multi', clientName: 'Мульти', locationId: 'l2', locationName: 'Юг', portions: 2 },
        { clientId: 'solo', clientName: 'Соло', locationId: 'l3', locationName: 'Центр', portions: 7 },
      ],
      totalPortions: 12,
      totalRevenue: 5000,
    })
    // У «Мульти» две локации → точки показаны.
    expect(text).toContain('🏢 Мульти · Север — 3 порции')
    expect(text).toContain('🏢 Мульти · Юг — 2 порции')
    // У «Соло» одна локация → точка опущена.
    expect(text).toContain('🏢 Соло — 7 порций')
    expect(text).not.toContain('Центр')
  })

  it('Волна 4: deliveryRevenue>0 добавляет хвост «+ X ₽ доставка», food-итог не меняется', () => {
    const text = formatProductionSummary({
      dateLabel: 'чт, 5 июня',
      orders: [{ clientId: 'a', clientName: 'Альфа', locationId: 'l1', locationName: 'Арбат', portions: 10 }],
      totalPortions: 10,
      totalRevenue: 12450,
      deliveryRevenue: 800,
    })
    // food-итог остался как был.
    expect(text).toContain(`Завтра: 1 заказ, 10 порций, ${formatMoney(12450)}`)
    // и к нему приклеился хвост доставки.
    expect(text).toContain(`${formatMoney(12450)} + ${formatMoney(800)} доставка`)
  })

  it('Волна 4: deliveryRevenue=0/отсутствует → хвоста доставки нет', () => {
    const text = formatProductionSummary({
      dateLabel: 'чт, 5 июня',
      orders: [{ clientId: 'a', clientName: 'Альфа', locationId: 'l1', locationName: 'Арбат', portions: 10 }],
      totalPortions: 10,
      totalRevenue: 1000,
    })
    expect(text).not.toContain('доставка')
  })

  it('блок «Не ответили» отображается отдельно при наличии', () => {
    const text = formatProductionSummary({
      dateLabel: 'чт, 5 июня',
      orders: [{ clientId: 'a', clientName: 'Альфа', locationId: 'l1', locationName: 'Арбат', portions: 10 }],
      totalPortions: 10,
      totalRevenue: 1000,
      unconfirmed: [{ clientName: 'Гамма', locationName: 'Никитская' }],
    })
    expect(text).toContain('⚠️ Не ответили (1):')
    expect(text).toContain('⏳ Никитская')
    expect(text).not.toContain('Гамма')
  })
})

describe('computeUnconfirmedConfigs (П3-механизм1: матчинг по бизнес-ключу)', () => {
  const config = {
    id: 'cfg-1',
    clientId: 'client-1',
    locationId: 'loc-1',
    mealType: 'LUNCH',
  }

  it('ручной MANUAL-заказ (sourceConfigId=null), совпадающий по (client,location,mealType) и CONFIRMED → конфиг НЕ в «Не ответили»', () => {
    const orders = [
      {
        sourceConfigId: null,
        clientId: 'client-1',
        locationId: 'loc-1',
        mealType: 'LUNCH',
        status: 'CONFIRMED',
      },
    ]
    expect(computeUnconfirmedConfigs([config], orders)).toEqual([])
  })

  it('DYNAMIC-конфиг без единого Order на завтра → в «Не ответили»', () => {
    expect(computeUnconfirmedConfigs([config], [])).toEqual([config])
  })

  it('Order в PENDING_CONFIRMATION НЕ считается отвеченным → конфиг в «Не ответили»', () => {
    const orders = [
      {
        sourceConfigId: 'cfg-1',
        clientId: 'client-1',
        locationId: 'loc-1',
        mealType: 'LUNCH',
        status: 'PENDING_CONFIRMATION',
      },
    ]
    expect(computeUnconfirmedConfigs([config], orders)).toEqual([config])
  })

  it('DRAFT и CANCELLED тоже НЕ считаются отвеченными', () => {
    const orders = [
      {
        clientId: 'client-1',
        locationId: 'loc-1',
        mealType: 'LUNCH',
        status: 'DRAFT',
      },
      {
        clientId: 'client-1',
        locationId: 'loc-1',
        mealType: 'LUNCH',
        status: 'CANCELLED',
      },
    ]
    expect(computeUnconfirmedConfigs([config], orders)).toEqual([config])
  })

  it('заказ с тем же клиентом/локацией, но другим mealType НЕ закрывает конфиг', () => {
    const orders = [
      {
        clientId: 'client-1',
        locationId: 'loc-1',
        mealType: 'BREAKFAST',
        status: 'CONFIRMED',
      },
    ]
    expect(computeUnconfirmedConfigs([config], orders)).toEqual([config])
  })

  it('LOCKED / IN_PRODUCTION / OUT_FOR_DELIVERY / DELIVERED считаются отвеченными', () => {
    for (const status of ['LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
      const orders = [
        { clientId: 'client-1', locationId: 'loc-1', mealType: 'LUNCH', status },
      ]
      expect(computeUnconfirmedConfigs([config], orders)).toEqual([])
    }
  })

  it('частичный матч в наборе конфигов: закрывается только совпавший', () => {
    const cfgA = { id: 'a', clientId: 'c1', locationId: 'l1', mealType: 'LUNCH' }
    const cfgB = { id: 'b', clientId: 'c2', locationId: 'l2', mealType: 'DINNER' }
    const orders = [
      { clientId: 'c1', locationId: 'l1', mealType: 'LUNCH', status: 'CONFIRMED' },
    ]
    expect(computeUnconfirmedConfigs([cfgA, cfgB], orders)).toEqual([cfgB])
  })
})
