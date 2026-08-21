import { describe, expect, it } from 'vitest'
import { parseYandexCoordinates } from './yandex-coordinates'

describe('parseYandexCoordinates', () => {
  it.each([
    [
      'll',
      'https://yandex.ru/maps/213/moscow/?ll=37.617635%2C55.755814&z=12',
      'll',
    ],
    [
      'pt',
      'https://yandex.ru/maps/?pt=37.617635,55.755814,pm2rdm',
      'pt',
    ],
    [
      'whatshere[point]',
      'https://yandex.ru/maps/?whatshere%5Bpoint%5D=37.617635%2C55.755814',
      'whatshere[point]',
    ],
    [
      'explicit lat/lon',
      'https://yandex.ru/maps/?lat=55.755814&lon=37.617635',
      'lat_lon',
    ],
  ])('extracts %s without swapping longitude and latitude', (_label, url, source) => {
    const result = parseYandexCoordinates(url)

    expect(result).toEqual({
      ok: true,
      coordinates: { latitude: 55.755814, longitude: 37.617635 },
      source,
    })
  })

  it('uses the first point when pt contains several markers', () => {
    const result = parseYandexCoordinates(
      'https://yandex.ru/maps/?pt=37.61,55.75,pm2rdm~38.1,56.2,pm2blm',
    )

    expect(result).toMatchObject({
      ok: true,
      coordinates: { latitude: 55.75, longitude: 37.61 },
    })
  })

  it('returns a typed hint for an unresolvable short link', () => {
    expect(parseYandexCoordinates('https://yandex.ru/maps/-/CDXExample')).toMatchObject({
      ok: false,
      error: { code: 'UNRESOLVABLE_SHORT_LINK' },
    })
  })

  it('rejects an invalid URL', () => {
    expect(parseYandexCoordinates('not a url')).toMatchObject({
      ok: false,
      error: { code: 'INVALID_URL' },
    })
  })

  it('rejects coordinate parameters copied from a non-Yandex host', () => {
    expect(
      parseYandexCoordinates('https://example.com/maps/?ll=37.617635%2C55.755814'),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_URL' },
    })
  })

  it('rejects out-of-range coordinates', () => {
    expect(parseYandexCoordinates('https://yandex.ru/maps/?ll=181,91')).toMatchObject({
      ok: false,
      error: { code: 'INVALID_COORDINATES' },
    })
  })

  it.each([
    'https://yandex.ru/maps/?ll=%2C',
    'https://yandex.ru/maps/?ll=37.6%2C',
    'https://yandex.ru/maps/?ll=%2C55.7',
  ])('rejects an empty coordinate token in %s', (url) => {
    expect(parseYandexCoordinates(url)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_COORDINATES' },
    })
  })

  it('does not guess coordinates when supported parameters are absent', () => {
    expect(parseYandexCoordinates('https://yandex.ru/maps/?z=12')).toMatchObject({
      ok: false,
      error: { code: 'COORDINATES_NOT_FOUND' },
    })
  })
})
