import { Prisma } from '@prisma/client'

/**
 * Превращает Prisma Decimal в number, рекурсивно обрабатывая объекты и массивы.
 * Нужно для передачи данных из Server Components в Client Components,
 * где Decimal не сериализуется через RSC-границу.
 *
 * Обрабатывает:
 * - Decimal → number
 * - Date — оставляет как есть (Next/RSC сериализует через JSON)
 * - вложенные объекты и массивы — рекурсивно
 * - null/undefined/примитивы — без изменений
 */
export function serialize<T>(value: T): T {
  if (value === null || value === undefined) {
    return value
  }

  // Decimal → number
  if (value instanceof Prisma.Decimal) {
    return Number(value) as T
  }

  // Date оставляем как есть — RSC сериализует Date нормально
  if (value instanceof Date) {
    return value
  }

  // Массивы — рекурсивно
  if (Array.isArray(value)) {
    return value.map((item) => serialize(item)) as T
  }

  // Объекты — рекурсивно по ключам
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key in value) {
      result[key] = serialize((value as Record<string, unknown>)[key])
    }
    return result as T
  }

  // Примитивы (string, number, boolean) — как есть
  return value
}
