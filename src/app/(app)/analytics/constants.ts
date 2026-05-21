// Серверная константа — не помечать 'use client'.
// Импортируется и из page.tsx (server), и из analytics-view.tsx (client).
// До этого MARGIN_MAX_DAYS жил в analytics-view ('use client') → при импорте
// в server-component резолвился в undefined → showMargin всегда false.

export const MARGIN_MAX_DAYS = 92 // квартал
export const DAILY_MODE_MAX = 31 // граница daily/monthly в графике
