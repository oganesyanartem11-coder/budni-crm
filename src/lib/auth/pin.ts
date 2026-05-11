import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db/prisma'

const SALT_ROUNDS = 10

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, SALT_ROUNDS)
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash)
}

/**
 * Валидация формата PIN: 4 цифры
 */
export function isValidPinFormat(pin: string): boolean {
  return /^\d{4}$/.test(pin)
}

/**
 * Генерирует 4-значный PIN, не совпадающий с PIN'ами существующих юзеров.
 * Bcrypt-хэши с разной солью разные даже для одного PIN'а, поэтому проверяем
 * через verifyPin(candidate, existingHash) для всех юзеров. До 50 попыток.
 */
export async function generateUniquePin(): Promise<string> {
  const all = await prisma.user.findMany({ select: { pinHash: true } })

  for (let i = 0; i < 50; i++) {
    const candidate = String(Math.floor(1000 + Math.random() * 9000))
    const collisions = await Promise.all(all.map((u) => verifyPin(candidate, u.pinHash)))
    if (!collisions.some(Boolean)) return candidate
  }
  throw new Error('Не удалось сгенерировать уникальный PIN после 50 попыток')
}
