// Ленивые читатели ENV роли «трафик Яндекс.Директа» (Борис-Директ).
// По образцу src/lib/telegram/env.ts: проверки кидаются только при первом
// вызове, чтобы билд/импорт не падали, пока переменные не проставлены.
// Значения токенов НИКОГДА не логировать и не включать в сообщения об ошибках.

const MIN_TOKEN_LENGTH = 20

function fail(varName: string, reason: string): never {
  throw new Error(
    `[boris-direct/env] ${varName} is invalid: ${reason}. ` +
      `Проверь .env.local (локально) и Vercel Environment Variables (прод).`
  )
}

/** OAuth-токен API Яндекс.Директа (заголовок Authorization: Bearer). */
export function readYandexDirectToken(): string {
  const v = process.env.YANDEX_DIRECT_TOKEN?.trim()
  if (!v) fail('YANDEX_DIRECT_TOKEN', 'not set')
  if (v.length < MIN_TOKEN_LENGTH) {
    fail('YANDEX_DIRECT_TOKEN', `too short (${v.length} < ${MIN_TOKEN_LENGTH})`)
  }
  return v
}

/** OAuth-токен API Метрики (заголовок Authorization: OAuth — НЕ Bearer!). */
export function readYandexMetricaToken(): string {
  const v = process.env.YANDEX_METRICA_TOKEN?.trim()
  if (!v) fail('YANDEX_METRICA_TOKEN', 'not set')
  if (v.length < MIN_TOKEN_LENGTH) {
    fail('YANDEX_METRICA_TOKEN', `too short (${v.length} < ${MIN_TOKEN_LENGTH})`)
  }
  return v
}
