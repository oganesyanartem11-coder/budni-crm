import { describe, it, expect } from 'vitest'
import { classifyQueryGeo, isGeoMinusReason, DELIVERY_REGION_IDS } from './geo'

describe('classifyQueryGeo — зона доставки Москва+МО (213+1)', () => {
  it('Москва и её формы → in_zone', () => {
    expect(classifyQueryGeo('корпоративное питание с доставкой москва')).toBe('in_zone')
    expect(classifyQueryGeo('обеды в офис москве')).toBe('in_zone')
    expect(classifyQueryGeo('доставка обедов московская область')).toBe('in_zone')
    expect(classifyQueryGeo('обеды мск')).toBe('in_zone')
    expect(classifyQueryGeo('питание для сотрудников подмосковье')).toBe('in_zone')
  })

  it('города МО — ЦЕЛЕВЫЕ (in_zone), не кандидаты в минус-гео', () => {
    // Названный владельцем пример.
    expect(classifyQueryGeo('доставка обедов электросталь')).toBe('in_zone')
    expect(classifyQueryGeo('обеды балашиха')).toBe('in_zone')
    expect(classifyQueryGeo('кейтеринг сергиев посад')).toBe('in_zone') // многословный
    expect(classifyQueryGeo('обеды наро-фоминск')).toBe('in_zone') // дефис
    expect(classifyQueryGeo('питание химки')).toBe('in_zone')
  })

  it('вне-зонные города → out_of_zone (структурный мусор)', () => {
    // Названные владельцем примеры.
    expect(classifyQueryGeo('корпоративное питание благовещенск')).toBe('out_of_zone')
    expect(classifyQueryGeo('доставка обедов элиста')).toBe('out_of_zone')
    // Другие регионы.
    expect(classifyQueryGeo('обеды в офис санкт-петербург')).toBe('out_of_zone')
    expect(classifyQueryGeo('доставка обедов екатеринбург')).toBe('out_of_zone')
    expect(classifyQueryGeo('кейтеринг нижний новгород')).toBe('out_of_zone') // многословный
    expect(classifyQueryGeo('обеды ростов-на-дону')).toBe('out_of_zone') // дефис
    expect(classifyQueryGeo('питание тула')).toBe('out_of_zone') // соседняя область, не МО
  })

  it('нет города / противоречие → unknown (решает LLM/владелец)', () => {
    expect(classifyQueryGeo('доставка обедов в офис')).toBe('unknown')
    expect(classifyQueryGeo('комплексный обед')).toBe('unknown')
    expect(classifyQueryGeo('')).toBe('unknown')
    // и Москва, и вне-зонный город в одном запросе — не берёмся судить.
    expect(classifyQueryGeo('доставка обедов из москвы в питер')).toBe('unknown')
  })

  it('ШАГ 6: города, которые эвристика пропускала на неделе 1 → out_of_zone', () => {
    // Реальные запросы недели с расходом, ранее классифицированные как unknown.
    expect(classifyQueryGeo('улан уде доставка обедов')).toBe('out_of_zone') // typo «уде»
    expect(classifyQueryGeo('доставка обедов улан-удэ')).toBe('out_of_zone')
    expect(classifyQueryGeo('обед с доставкой саранск')).toBe('out_of_zone')
    expect(classifyQueryGeo('кропоткин заказать обед')).toBe('out_of_zone')
    expect(classifyQueryGeo('доставка обедов уралан')).toBe('out_of_zone')
    // Ещё несколько из системного пополнения.
    expect(classifyQueryGeo('обеды пятигорск')).toBe('out_of_zone')
    expect(classifyQueryGeo('доставка обедов старый оскол')).toBe('out_of_zone') // многословный
  })

  it('ШАГ 6: метро «Кропоткинская» (Москва) НЕ ловится токеном «кропоткин»', () => {
    // Целевой московский запрос у метро Кропоткинская — другой токен, не режем.
    expect(classifyQueryGeo('обеды у метро кропоткинская москва')).toBe('in_zone')
    // Без сигнала Москвы «кропоткинская» сама по себе не делает out_of_zone.
    expect(classifyQueryGeo('обеды кропоткинская')).toBe('unknown')
  })

  it('токен-матч не ловит ложные подстроки (томск ≠ омск)', () => {
    // «томск» — вне зоны, но НЕ из-за подстроки «омск»: проверяем что омск-токен
    // не всплывает ложно на других словах.
    expect(classifyQueryGeo('обеды томск')).toBe('out_of_zone')
    expect(classifyQueryGeo('доставка обедов офис')).toBe('unknown') // нет «омск» ложно
  })

  it('DELIVERY_REGION_IDS = [213, 1]', () => {
    expect(DELIVERY_REGION_IDS).toEqual([213, 1])
  })
})

describe('isGeoMinusReason — детект гео-мотива в обосновании LLM', () => {
  it('гео-обоснования → true', () => {
    expect(isGeoMinusReason('запрос вне Москвы и МО')).toBe(true)
    expect(isGeoMinusReason('другой регион')).toBe(true)
    expect(isGeoMinusReason('город не в Москве')).toBe(true)
    expect(isGeoMinusReason('за пределами зоны доставки')).toBe(true)
    expect(isGeoMinusReason('Ростовская область')).toBe(true)
  })

  it('не-гео обоснования → false', () => {
    expect(isGeoMinusReason('рецепт обеда для одного')).toBe(false)
    expect(isGeoMinusReason('чужой бренд/конкурент')).toBe(false)
    expect(isGeoMinusReason('вакансия повара')).toBe(false)
    expect(isGeoMinusReason(undefined)).toBe(false)
    expect(isGeoMinusReason('')).toBe(false)
  })
})
