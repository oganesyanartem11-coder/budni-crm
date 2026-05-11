export const MIN_PORTIONS_THRESHOLD = 10
export const MAX_PORTIONS_THRESHOLD = 200
export const ANOMALY_DEVIATION_PCT = 0.5
export const NEW_CLIENT_SAFE_STREAK = 5
export const LLM_CONFIDENCE_THRESHOLD = 0.8

// Подозрительно ровные числа — частые опечатки клиента
export const SUSPICIOUS_ROUND_NUMBERS = new Set<number>([100, 200, 300, 500, 777, 1000])
