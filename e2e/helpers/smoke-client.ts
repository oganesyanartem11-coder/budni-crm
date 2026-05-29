/**
 * Константы и хелперы для работы с SMOKE_TEST_CLIENT в e2e-тестах.
 * Сам seed — scripts/seed-smoke-client.ts (npm run db:seed:smoke).
 */

export const SMOKE_CLIENT_NAME = 'SMOKE_TEST_CLIENT'
export const SMOKE_LOCATION_NAME = 'SMOKE_TEST_LOCATION'
export const SMOKE_LEGAL_SHORT_NAME = 'SMOKE_TEST_LEGAL'

/** Префикс, по которому всегда узнаём тестовые сущности (для cleanup). */
export const SMOKE_PREFIX = 'SMOKE_TEST_'
