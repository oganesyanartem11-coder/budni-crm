'use client'
import exifr from 'exifr'

export interface ExifResult {
  takenAt: Date | null
  isSuspicious: boolean
}

export async function extractExif(file: File): Promise<ExifResult> {
  try {
    const parsed = await exifr.parse(file, { tiff: true, exif: true })
    const takenRaw = parsed?.DateTimeOriginal ?? parsed?.CreateDate ?? null
    const takenAt = takenRaw instanceof Date ? takenRaw : takenRaw ? new Date(takenRaw) : null

    let isSuspicious = false
    if (!takenAt) {
      // EXIF может быть удалён намеренно (например, скриншот накладной),
      // помечаем для пост-аудита.
      isSuspicious = true
    } else {
      // Слишком старая дата (>30 дней до now) или из будущего — подозрительно.
      const diffDays = (Date.now() - takenAt.getTime()) / (24 * 60 * 60 * 1000)
      if (diffDays > 30 || diffDays < -1) isSuspicious = true
    }

    return { takenAt, isSuspicious }
  } catch {
    // Если EXIF не парсится — тоже подозрительно (некорректный файл).
    return { takenAt: null, isSuspicious: true }
  }
}
