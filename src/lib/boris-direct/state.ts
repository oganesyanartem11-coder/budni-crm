/**
 * Состояние роли «трафик» (Борис-Директ): режим observe|live, стоп-кран,
 * гейт спорных минусов. Singleton-строка BorisDirectState (key='main').
 *
 * Сид не нужен: НЕТ строки в БД = дефолты (OBSERVE, не frozen, гейт стоит) —
 * так пустая/новая БД всегда безопасна. Live включает ТОЛЬКО владелец
 * командой в Telegram; код сам live не включает никогда.
 */

import { prisma } from '@/lib/db/prisma'
import type { BorisDirectMode } from '@prisma/client'

const STATE_KEY = 'main'

export interface DirectRoleState {
  mode: BorisDirectMode
  frozen: boolean
  autoNegativesEnabled: boolean
}

const DEFAULT_STATE: DirectRoleState = {
  mode: 'OBSERVE',
  frozen: false,
  autoNegativesEnabled: false,
}

export async function getDirectRoleState(): Promise<DirectRoleState> {
  const row = await prisma.borisDirectState.findUnique({ where: { key: STATE_KEY } })
  if (!row) return { ...DEFAULT_STATE }
  return {
    mode: row.mode,
    frozen: row.frozen,
    autoNegativesEnabled: row.autoNegativesEnabled,
  }
}

/** Переключение режима — вызывается ТОЛЬКО из обработчика команд владельца. */
export async function setDirectMode(mode: BorisDirectMode): Promise<void> {
  await prisma.borisDirectState.upsert({
    where: { key: STATE_KEY },
    create: { key: STATE_KEY, mode, modeChangedAt: new Date() },
    update: { mode, modeChangedAt: new Date() },
  })
}

/** Стоп-кран «Борис, стоп» / «Борис, продолжай» (перекрывает live). */
export async function setDirectFrozen(frozen: boolean): Promise<void> {
  await prisma.borisDirectState.upsert({
    where: { key: STATE_KEY },
    create: { key: STATE_KEY, frozen, frozenChangedAt: new Date() },
    update: { frozen, frozenChangedAt: new Date() },
  })
}

/** Гейт спорных минусов: снимается по подтверждению владельца, возвращается командой. */
export async function setAutoNegativesEnabled(enabled: boolean): Promise<void> {
  await prisma.borisDirectState.upsert({
    where: { key: STATE_KEY },
    create: { key: STATE_KEY, autoNegativesEnabled: enabled },
    update: { autoNegativesEnabled: enabled },
  })
}
