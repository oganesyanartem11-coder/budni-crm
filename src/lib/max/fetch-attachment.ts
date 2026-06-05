/**
 * Скачивание вложения MAX (фото заявки) по прямому URL из payload.
 *
 * MAX-attachment image: { type:'image', payload: { url, token, photo_id } } —
 * payload.url прямой загружаемый URL. Качаем байты, отдаём И base64 (для
 * vision-парсера parseWeeklySubmission), И сырой Buffer (для blob-аплоада
 * оригинала в processWeeklySubmission).
 */

export type WeeklyMediaType = 'image/jpeg' | 'image/png' | 'image/webp'

export interface FetchedAttachment {
  base64: string
  buffer: Buffer
  mediaType: WeeklyMediaType
}

/**
 * Резолвит media-type из Content-Type заголовка, иначе из расширения URL.
 * Парсер weekly принимает только jpeg/png/webp — всё прочее (heic и т.п.)
 * приводим к 'image/jpeg' дефолтом.
 */
function resolveMediaType(contentType: string | null, url: string): WeeklyMediaType {
  const ct = (contentType ?? '').split(';')[0]?.trim().toLowerCase()
  if (ct === 'image/png') return 'image/png'
  if (ct === 'image/webp') return 'image/webp'
  if (ct === 'image/jpeg' || ct === 'image/jpg') return 'image/jpeg'

  // Фоллбэк по расширению из пути URL (без query-string).
  const path = url.split('?')[0]?.toLowerCase() ?? ''
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'

  return 'image/jpeg'
}

export async function fetchAttachmentAsBase64(url: string): Promise<FetchedAttachment> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`fetch attachment failed: ${res.status} ${res.statusText}`)
  }
  const arrayBuffer = await res.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const mediaType = resolveMediaType(res.headers.get('content-type'), url)
  return { base64: buffer.toString('base64'), buffer, mediaType }
}
