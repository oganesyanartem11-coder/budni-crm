import { Prisma } from '@prisma/client'
import type { Decimal } from '@prisma/client/runtime/library'

/**
 * Mapped-тип: рекурсивно заменяет Decimal на number в типе T.
 * Используется как возвращаемый тип serialize(), чтобы TypeScript
 * после serialize() видел number вместо Decimal без ручных Omit<>.
 *
 * Date оставляем как есть — RSC сериализует Date штатно.
 */
export type Serialized<T> = T extends Decimal
  ? number
  : T extends Date
  ? Date
  : T extends null
  ? null
  : T extends undefined
  ? undefined
  : T extends Array<infer U>
  ? Array<Serialized<U>>
  : T extends object
  ? { [K in keyof T]: Serialized<T[K]> }
  : T

/**
 * Превращает Prisma Decimal в number, рекурсивно обрабатывая объекты и массивы.
 * Нужно для передачи данных из Server Components в Client Components,
 * где Decimal не сериализуется через RSC-границу.
 */
export function serialize<T>(value: T): Serialized<T> {
  if (value === null || value === undefined) {
    return value as Serialized<T>
  }

  if (value instanceof Prisma.Decimal) {
    return Number(value) as Serialized<T>
  }

  if (value instanceof Date) {
    return value as Serialized<T>
  }

  if (Array.isArray(value)) {
    return value.map((item) => serialize(item)) as Serialized<T>
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key in value) {
      result[key] = serialize((value as Record<string, unknown>)[key])
    }
    return result as Serialized<T>
  }

  return value as Serialized<T>
}
