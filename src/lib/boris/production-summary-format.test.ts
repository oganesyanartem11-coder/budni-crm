import { describe, it, expect } from 'vitest'
import { formatMoney } from '@/lib/utils/format'
import {
  formatProductionSummary,
  formatProductionSummaryRow,
  sortProductionSummaryRows,
  computeUnconfirmedConfigs,
} from './production-summary-format'

describe('formatProductionSummaryRow', () => {
  it('строка: «📍 {Локация} — N порций», без имени клиента', () => {
    const row = formatProductionSummaryRow({
      clientName: 'Кофейня У Дома',
      locationName: 'Тверская',
      portions: 12,
    })
    expect(row).toBe('📍 Тверская — 12 порций')
    expect(row).not.toContain('Кофейня У Дома')
  })

  it('не содержит имя клиента, ООО/ИП/юридического названия; содержит локацию, порции и 📍', () => {
    const row = formatProductionSummaryRow({
      clientName: 'Сеть Кафе',
      locationName: 'Арбат',
      portions: 1,
    })
    // только 📍 + локация + порции
    expect(row).toBe('📍 Арбат — 1 порция')
    expect(row).toContain('📍')
    expect(row).toContain('Арбат')
    expect(row).toContain('1 порция')
    expect(row).not.toContain('Сеть Кафе')
    expect(row).not.toMatch(/ООО|ИП|юр/i)
  })
})

describe('sortProductionSummaryRows', () => {
  it('сортирует по локации алфавитно, затем по клиенту', () => {
    const sorted = sortProductionSummaryRows([
      { clientName: 'Бета', locationName: 'Тверская', portions: 5 },
      { clientName: 'Гамма', locationName: 'Арбат', portions: 5 },
      { clientName: 'Альфа', locationName: 'Арбат', portions: 5 },
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
        { clientName: 'Альфа', locationName: 'Арбат', portions: 10 },
        { clientName: 'Бета', locationName: 'Тверская', portions: 5 },
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
    const text = formatProductionSummary({
      dateLabel: 'чт, 5 июня',
      orders: [
        { clientName: 'Бета', locationName: 'Тверская', portions: 5 },
        { clientName: 'Альфа', locationName: 'Арбат', portions: 10 },
      ],
      totalPortions: 15,
      totalRevenue: 1000,
    })
    const arbat = text.indexOf('📍 Арбат')
    const tverskaya = text.indexOf('📍 Тверская')
    expect(arbat).toBeGreaterThan(-1)
    expect(tverskaya).toBeGreaterThan(-1)
    expect(arbat).toBeLessThan(tverskaya)
    // имена клиентов не отображаются в строках
    expect(text).not.toContain('Альфа')
    expect(text).not.toContain('Бета')
  })

  it('заказы DYNAMIC и FIXED в одном списке без разделения на блоки', () => {
    const text = formatProductionSummary({
      dateLabel: 'чт, 5 июня',
      orders: [
        { clientName: 'Клиент-А', locationName: 'Точка-1', portions: 8 },
        { clientName: 'Клиент-А', locationName: 'Точка-2', portions: 4 },
      ],
      totalPortions: 12,
      totalRevenue: 5000,
    })
    expect(text).toContain('📍 Точка-1 — 8 порций')
    expect(text).toContain('📍 Точка-2 — 4 порции')
    expect(text).not.toContain('Клиент-А')
    expect(text).not.toContain('Подтверждено')
    expect(text).not.toContain('Фиксированные')
  })

  it('Волна 4: deliveryRevenue>0 добавляет хвост «+ X ₽ доставка», food-итог не меняется', () => {
    const text = formatProductionSummary({
      dateLabel: 'чт, 5 июня',
      orders: [{ clientName: 'Альфа', locationName: 'Арбат', portions: 10 }],
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
      orders: [{ clientName: 'Альфа', locationName: 'Арбат', portions: 10 }],
      totalPortions: 10,
      totalRevenue: 1000,
    })
    expect(text).not.toContain('доставка')
  })

  it('блок «Не ответили» отображается отдельно при наличии', () => {
    const text = formatProductionSummary({
      dateLabel: 'чт, 5 июня',
      orders: [{ clientName: 'Альфа', locationName: 'Арбат', portions: 10 }],
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
