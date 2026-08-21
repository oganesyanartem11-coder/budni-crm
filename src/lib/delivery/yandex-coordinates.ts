export type YandexCoordinateSource =
  | 'll'
  | 'pt'
  | 'whatshere[point]'
  | 'lat_lon'

export type YandexCoordinateErrorCode =
  | 'INVALID_URL'
  | 'UNRESOLVABLE_SHORT_LINK'
  | 'COORDINATES_NOT_FOUND'
  | 'INVALID_COORDINATES'

export type YandexCoordinateParseResult =
  | {
      ok: true
      coordinates: { latitude: number; longitude: number }
      source: YandexCoordinateSource
    }
  | {
      ok: false
      error: { code: YandexCoordinateErrorCode; message: string }
    }

function error(
  code: YandexCoordinateErrorCode,
  message: string,
): YandexCoordinateParseResult {
  return { ok: false, error: { code, message } }
}

export function areValidCoordinates(
  latitude: number,
  longitude: number,
): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  )
}

function resultFromLonLat(
  raw: string,
  source: Exclude<YandexCoordinateSource, 'lat_lon'>,
): YandexCoordinateParseResult {
  const firstPoint = raw.split('~', 1)[0]?.trim() ?? ''
  const [rawLongitude, rawLatitude] = firstPoint.split(',')
  const longitudeToken = rawLongitude?.trim() ?? ''
  const latitudeToken = rawLatitude?.trim() ?? ''

  if (!longitudeToken || !latitudeToken) {
    return error(
      'INVALID_COORDINATES',
      'Ссылка содержит неполную пару координат',
    )
  }

  const longitude = Number(longitudeToken)
  const latitude = Number(latitudeToken)

  if (!areValidCoordinates(latitude, longitude)) {
    return error(
      'INVALID_COORDINATES',
      'Ссылка содержит координаты вне допустимого диапазона',
    )
  }

  return {
    ok: true,
    coordinates: { latitude, longitude },
    source,
  }
}

function firstParam(url: URL, names: readonly string[]): string | null {
  for (const name of names) {
    const value = url.searchParams.get(name)
    if (value !== null && value.trim() !== '') return value
  }
  return null
}

function isSupportedYandexHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === 'yandex.ru' ||
    host.endsWith('.yandex.ru') ||
    host === 'yandex.com' ||
    host.endsWith('.yandex.com') ||
    host === 'ya.cc' ||
    host === 'yandex.link'
  )
}

/**
 * Parses coordinates embedded in a full Yandex Maps URL. It never follows
 * redirects: opaque short links must be expanded by the user in Yandex Maps.
 */
export function parseYandexCoordinates(
  input: string,
): YandexCoordinateParseResult {
  let url: URL
  try {
    url = new URL(input.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return error('INVALID_URL', 'Вставьте полную ссылку Яндекс.Карт')
    }
  } catch {
    return error('INVALID_URL', 'Не удалось прочитать ссылку')
  }

  if (!isSupportedYandexHost(url.hostname)) {
    return error('INVALID_URL', 'Вставьте полную ссылку Яндекс.Карт')
  }

  const ll = firstParam(url, ['ll'])
  if (ll) return resultFromLonLat(ll, 'll')

  const point = firstParam(url, ['whatshere[point]'])
  if (point) return resultFromLonLat(point, 'whatshere[point]')

  const pt = firstParam(url, ['pt'])
  if (pt) return resultFromLonLat(pt, 'pt')

  const rawLatitude = firstParam(url, ['lat', 'latitude'])
  const rawLongitude = firstParam(url, ['lon', 'lng', 'longitude'])
  if (rawLatitude !== null || rawLongitude !== null) {
    const latitude = Number(rawLatitude)
    const longitude = Number(rawLongitude)
    if (!rawLatitude || !rawLongitude || !areValidCoordinates(latitude, longitude)) {
      return error(
        'INVALID_COORDINATES',
        'Ссылка содержит неполную или неверную пару координат',
      )
    }
    return {
      ok: true,
      coordinates: { latitude, longitude },
      source: 'lat_lon',
    }
  }

  const hostname = url.hostname.toLowerCase()
  const isOpaqueShortLink =
    url.pathname.includes('/-/') ||
    hostname === 'ya.cc' ||
    hostname === 'yandex.link'
  if (isOpaqueShortLink) {
    return error(
      'UNRESOLVABLE_SHORT_LINK',
      'Короткая ссылка не содержит координат. Откройте её и скопируйте полную ссылку из Яндекс.Карт.',
    )
  }

  return error(
    'COORDINATES_NOT_FOUND',
    'Ссылка не содержит координат. Скопируйте полную ссылку на выбранную точку.',
  )
}
