import { renderToBuffer } from '@react-pdf/renderer'
import { RouteSheetPdfDocument } from '@/app/(app)/production/print/route-sheet/pdf-document'
import type { RouteSheetRow } from './build-rows'

/** Дата → "DD.MM.YYYY" (UTC-полночь МСК-даты, читаем UTC-компоненты). */
export function formatRouteSheetDate(date: Date): string {
  const d = String(date.getUTCDate()).padStart(2, '0')
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const y = date.getUTCFullYear()
  return `${d}.${m}.${y}`
}

/** ASCII-safe имя файла листа: route-sheet-YYYY-MM-DD.pdf (опц. суффикс). */
export function routeSheetFilename(date: Date, suffix?: string): string {
  const ymd = date.toISOString().slice(0, 10)
  return `route-sheet-${ymd}${suffix ? '-' + suffix : ''}.pdf`
}

/**
 * Рендер PDF маршрутного листа в Buffer. Вызывается и из роут-хэндлера, и из
 * cron'ов (напрямую, без HTTP-самозапроса).
 */
export async function renderRouteSheetPdf(
  deliveryDate: Date,
  rows: RouteSheetRow[]
): Promise<Buffer> {
  const dateLabel = formatRouteSheetDate(deliveryDate)
  return renderToBuffer(<RouteSheetPdfDocument dateLabel={dateLabel} rows={rows} />)
}
