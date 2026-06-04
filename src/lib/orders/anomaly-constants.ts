// MEGA-4a (П10): глобальные пороги MIN_PORTIONS_THRESHOLD=10 /
// MAX_PORTIONS_THRESHOLD=200, ANOMALY_DEVIATION_PCT и SUSPICIOUS_ROUND_NUMBERS
// удалены — проверка «цифра вне нормы» теперь динамическая (50–200% от
// истории клиента по дню недели), см. detectPortionAnomaly в anomaly-detector.ts.

// 5.7c: снижено с 5 до 0 — бот доверяет числу сразу, без раскачки.
// Ветка detectAnomalies → NEW_CLIENT остаётся, но с порогом 0 не срабатывает.
export const NEW_CLIENT_SAFE_STREAK = 0
export const LLM_CONFIDENCE_THRESHOLD = 0.8
