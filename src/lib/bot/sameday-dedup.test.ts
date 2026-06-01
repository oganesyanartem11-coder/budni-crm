import { describe, it, expect } from 'vitest'
import { toMskDateString } from '@/lib/utils/msk-window'

/**
 * 7.39: deduplKey для SAMEDAY_ORDER_LOCKED.
 * Формат `sameday-locked:${orderId}:${yyyymmdd}` должен быть детерминированным
 * для одного заказа в один МСК-день — это гарантирует, что повторный перевод
 * conv в CONFIRMED (или повторный ответ клиента в тот же день) не плодит дубль
 * поста (unique constraint BorisEventLog.deduplKey ловит P2002 → logBorisEvent
 * возвращает null). Дату фиксируем через переданный Date — без Date.now().
 */
function buildSameDayDeduplKey(orderId: string, deliveryDate: Date): string {
  return `sameday-locked:${orderId}:${toMskDateString(deliveryDate)}`
}

describe('SAMEDAY_ORDER_LOCKED deduplKey', () => {
  const orderId = 'order_abc123'

  it('стабилен для одного заказа в один МСК-день (UTC-полночь @db.Date)', () => {
    // @db.Date deliveryDate хранится как UTC-полночь календарной даты.
    const deliveryDate = new Date('2026-06-01T00:00:00.000Z')
    expect(buildSameDayDeduplKey(orderId, deliveryDate)).toBe('sameday-locked:order_abc123:2026-06-01')
  })

  it('одинаков для двух вызовов с тем же orderId и днём (дедуп работает)', () => {
    const deliveryDate = new Date('2026-06-01T00:00:00.000Z')
    const first = buildSameDayDeduplKey(orderId, deliveryDate)
    const second = buildSameDayDeduplKey(orderId, deliveryDate)
    expect(first).toBe(second)
  })

  it('разный для разных заказов в один день', () => {
    const deliveryDate = new Date('2026-06-01T00:00:00.000Z')
    expect(buildSameDayDeduplKey('order_a', deliveryDate)).not.toBe(
      buildSameDayDeduplKey('order_b', deliveryDate),
    )
  })

  it('разный для одного заказа в разные дни', () => {
    expect(buildSameDayDeduplKey(orderId, new Date('2026-06-01T00:00:00.000Z'))).not.toBe(
      buildSameDayDeduplKey(orderId, new Date('2026-06-02T00:00:00.000Z')),
    )
  })

  it('day-only ключ устойчив к разному времени суток того же МСК-дня', () => {
    // МСК 09:00 и МСК 23:00 одного календарного дня → один и тот же ключ.
    const morning = new Date('2026-06-01T06:00:00.000Z') // МСК 09:00
    const evening = new Date('2026-06-01T20:00:00.000Z') // МСК 23:00
    expect(buildSameDayDeduplKey(orderId, morning)).toBe(buildSameDayDeduplKey(orderId, evening))
  })
})
