import { describe, expect, it } from 'vitest'
import type { CourierAssignmentOrder } from './courier-queries'
import {
  formatCourierAssignmentMessages,
  groupCourierAssignments,
} from './courier-assignment-summary'

function order(over: Partial<CourierAssignmentOrder> = {}): CourierAssignmentOrder {
  return {
    orderId: 'order_1',
    clientId: 'client_1',
    clientName: 'СтальСтройМонтаж',
    clientContactName: 'Контакт',
    clientContactPhone: '+7 900 000-00-00',
    locationId: 'loc_1',
    locationName: 'ТЭЦ',
    locationAddress: 'ул. Промышленная, 1',
    deliveryWindowFrom: '09:00',
    deliveryWindowTo: '10:00',
    mealType: 'LUNCH',
    portions: 20,
    status: 'CONFIRMED',
    assignedCourierId: 'courier_anna',
    assignedCourier: { id: 'courier_anna', name: 'Анна' },
    assignmentMode: 'IN_HOUSE',
    courierLabel: 'Анна',
    packaging: 'INDIVIDUAL',
    tags: [],
    notes: null,
    ...over,
  }
}

describe('groupCourierAssignments', () => {
  it('агрегирует локацию, сохраняет meal breakdown и ставит InDrive последним', () => {
    const groups = groupCourierAssignments([
      order({
        orderId: 'unassigned',
        locationId: 'loc_4',
        locationName: 'Без курьера',
        assignedCourierId: null,
        assignedCourier: null,
        assignmentMode: 'EXTERNAL',
        courierLabel: 'InDrive',
        portions: 4,
      }),
      order({
        orderId: 'anna_dinner',
        mealType: 'DINNER',
        portions: 7,
      }),
      order({
        orderId: 'boris',
        locationId: 'loc_3',
        locationName: 'Склад',
        assignedCourierId: 'courier_boris',
        assignedCourier: { id: 'courier_boris', name: 'Борис' },
        assignmentMode: 'IN_HOUSE',
        courierLabel: 'Борис',
        portions: 8,
      }),
      order({ orderId: 'anna_lunch', portions: 5 }),
      order({
        orderId: 'anna_early',
        locationId: 'loc_2',
        locationName: 'Ангар',
        deliveryWindowFrom: '08:30',
        portions: 3,
      }),
    ])

    expect(groups.map((group) => group.courierLabel)).toEqual(['Анна', 'Борис', 'InDrive'])
    expect(groups[0].stops.map((stop) => stop.locationName)).toEqual(['Ангар', 'ТЭЦ'])
    expect(groups[0].stops[1]).toEqual(expect.objectContaining({
      locationId: 'loc_1',
      totalPortions: 12,
      orderIds: ['anna_dinner', 'anna_lunch'],
      meals: [
        { mealType: 'LUNCH', portions: 5 },
        { mealType: 'DINNER', portions: 7 },
      ],
    }))
    expect(groups[2].assignedCourier).toBeNull()
  })
})

describe('formatCourierAssignmentMessages', () => {
  it('даёт точный HTML, экранирует данные и не выводит raw enum', () => {
    const groups = groupCourierAssignments([
      order({
        clientName: 'Сталь & Монтаж',
        locationName: 'ТЭЦ <1>',
        locationAddress: 'ул. А & Б',
        clientContactPhone: '+7 <900>',
        deliveryWindowFrom: '09:00 & <окно>',
        assignedCourier: { id: 'courier_1', name: 'Анна & Ко' },
        assignedCourierId: 'courier_1',
        courierLabel: 'Анна & Ко',
        portions: 12,
      }),
    ])

    expect(formatCourierAssignmentMessages(groups, new Date('2026-08-07T00:00:00.000Z')))
      .toEqual([
        '🚚 Курьеры на завтра — 07.08.2026\n\n' +
        '<b>Анна &amp; Ко</b> — 1 точка, 12 порций\n\n' +
        '1. 09:00 &amp; &lt;окно&gt; · <b>ТЭЦ &lt;1&gt;</b> (Сталь &amp; Монтаж)\n' +
        '   <code>ул. А &amp; Б</code>\n' +
        '   <code>+7 &lt;900&gt;</code>\n' +
        '   Обед — 12 порций',
      ])
  })

  it('для null courier показывает InDrive и пропускает пустой телефон без empty code', () => {
    const groups = groupCourierAssignments([
      order({
        assignedCourierId: null,
        assignedCourier: null,
        assignmentMode: 'EXTERNAL',
        courierLabel: 'InDrive',
        clientContactPhone: null,
      }),
    ])

    const text = formatCourierAssignmentMessages(
      groups,
      new Date('2026-08-07T00:00:00.000Z'),
    )[0]

    expect(text).toContain('<b>InDrive</b> — 1 точка, 20 порций')
    expect(text).not.toContain('<code></code>')
    expect(text).not.toContain('LUNCH')
    expect(text).not.toContain('**')
  })

  it('keeps EXTERNAL and UNASSIGNED in separate daily sections', () => {
    const groups = groupCourierAssignments([
      order({
        orderId: 'external',
        locationId: 'external-location',
        assignedCourierId: null,
        assignedCourier: null,
        assignmentMode: 'EXTERNAL',
        courierLabel: 'InDrive',
      }),
      order({
        orderId: 'unassigned',
        locationId: 'unassigned-location',
        assignedCourierId: null,
        assignedCourier: null,
        assignmentMode: 'UNASSIGNED',
        courierLabel: 'Не назначено',
      }),
    ])

    expect(groups.map((group) => group.courierLabel)).toEqual([
      'InDrive',
      'Не назначено',
    ])
    const text = formatCourierAssignmentMessages(groups, new Date('2026-08-07T00:00:00.000Z'))[0]
    expect(text).toContain('<b>InDrive</b>')
    expect(text).toContain('<b>Не назначено</b>')
  })

  it('длинный отчёт делит только по stops/sections, не ломая HTML', () => {
    const rows = Array.from({ length: 90 }, (_, index) => order({
      orderId: `order_${index}`,
      locationId: `loc_${index}`,
      locationName: `Точка ${String(index).padStart(2, '0')}`,
      locationAddress: `Адрес для остановки ${index}`,
    }))

    const messages = formatCourierAssignmentMessages(
      groupCourierAssignments(rows),
      new Date('2026-08-07T00:00:00.000Z'),
    )

    expect(messages.length).toBeGreaterThan(1)
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(4096)
      expect((message.match(/<b>/g) ?? []).length).toBe((message.match(/<\/b>/g) ?? []).length)
      expect((message.match(/<code>/g) ?? []).length)
        .toBe((message.match(/<\/code>/g) ?? []).length)
      expect(message.startsWith('🚚 Курьеры на завтра — 07.08.2026')).toBe(true)
    }
    const joined = messages.join('\n')
    expect(joined).toContain('Точка 00')
    expect(joined).toContain('Точка 89')
  })
})
