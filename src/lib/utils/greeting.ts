/**
 * Приветствие по времени суток (по локальной таймзоне сервера/клиента).
 * Используется в /login и /dashboard. Страница-вызыватель должна быть
 * `export const dynamic = 'force-dynamic'`, иначе значение застынет на SSG.
 */
export function getGreeting(date: Date = new Date()): string {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return 'Доброе утро'
  if (hour >= 12 && hour < 18) return 'Добрый день'
  if (hour >= 18 && hour < 23) return 'Добрый вечер'
  return 'Доброй ночи'
}
