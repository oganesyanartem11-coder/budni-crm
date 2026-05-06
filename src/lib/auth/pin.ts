import bcrypt from 'bcryptjs'

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
