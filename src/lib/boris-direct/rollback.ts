/**
 * Откат последнего пишущего действия («Борис, откати последнее»).
 *
 * Берём последнюю запись BorisDirectActionLog с applied=true и revertedAt=null
 * и применяем обратное действие ЧЕРЕЗ write-gate (мимо гейта не ходим даже
 * при откате): ставки — вернуть before-ставки, минуса — вернуть before-список.
 * Исходная запись помечается revertedAt, новая получает revertOfId.
 *
 * keywords.suspend / campaigns.suspend НЕ откатываем автоматически:
 * resume не входит в разрешённый набор операций — только вручную.
 */

import { prisma } from '@/lib/db/prisma'
import { applyBidChanges, applyNegativeKeywords } from './write-gate'

export interface RevertResult {
  ok: boolean
  /** Человеческий текст для чата (голосом Бориса пишет вызывающий код). */
  message: string
}

/** Что умеем откатывать: у обеих операций есть точный before в логе. */
const REVERTIBLE_ACTIONS = ['keywordbids.set', 'campaigns.update.negatives']

/** Остановки не откатываем (resume вне разрешённого набора операций). */
const SUSPEND_ACTIONS = ['keywords.suspend', 'campaigns.suspend']

const REVERT_REASON = 'откат по команде владельца'

/** before/after ставок из лога: [{ keywordId, bidMicro }] — иначе null. */
function asBidList(value: unknown): Array<{ keywordId: number; bidMicro: number }> | null {
  if (!Array.isArray(value)) return null
  const list: Array<{ keywordId: number; bidMicro: number }> = []
  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof (item as Record<string, unknown>).keywordId !== 'number' ||
      typeof (item as Record<string, unknown>).bidMicro !== 'number'
    ) {
      return null
    }
    const row = item as { keywordId: number; bidMicro: number }
    list.push({ keywordId: row.keywordId, bidMicro: row.bidMicro })
  }
  return list
}

/** before/after минус-списка из лога: string[] — иначе null. */
function asStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every((item) => typeof item === 'string') ? (value as string[]) : null
}

export async function revertLastAction(): Promise<RevertResult> {
  // Последнее ПРИМЕНЁННОЕ и не откаченное действие (учитываем и остановки:
  // если последним был suspend — честно отказываем, а не тихо откатываем
  // более старую правку).
  const last = await prisma.borisDirectActionLog.findFirst({
    where: {
      applied: true,
      revertedAt: null,
      action: { in: [...REVERTIBLE_ACTIONS, ...SUSPEND_ACTIONS] },
    },
    orderBy: { createdAt: 'desc' },
  })

  if (!last) {
    return { ok: false, message: 'Откатывать нечего — применённых действий в Директе не было.' }
  }

  if (SUSPEND_ACTIONS.includes(last.action)) {
    return {
      ok: false,
      message: `Последнее действие — ${last.action}: остановки автоматически не откатываю (возобновление не входит в мой набор операций). Включить обратно можно вручную в интерфейсе Директа.`,
    }
  }

  if (last.action === 'keywordbids.set') {
    const before = asBidList(last.before)
    const after = asBidList(last.after)
    if (!before || !after) {
      return { ok: false, message: 'В записи лога нет корректных before/after — откатить ставки не могу.' }
    }

    const afterById = new Map(after.map((b) => [b.keywordId, b.bidMicro]))
    // Обратное действие: from = что стоит сейчас (after), to = что было (before).
    const changes = before.map((b) => ({
      keywordId: b.keywordId,
      fromMicro: afterById.get(b.keywordId) ?? b.bidMicro,
      toMicro: b.bidMicro,
    }))

    const gate = await applyBidChanges(changes, REVERT_REASON, last.id)
    if (gate.breakerTripped) {
      return { ok: false, message: 'Circuit breaker не пропустил откат ставок — пачка вне паттерна, нужен ручной разбор.' }
    }
    if (!gate.applied) {
      return { ok: false, message: 'Откат ставок не применён: режим наблюдения или стоп-кран. Записал как «сделал бы».' }
    }

    await prisma.borisDirectActionLog.update({
      where: { id: last.id },
      data: { revertedAt: new Date() },
    })
    return { ok: true, message: `Откатил ставки по ${changes.length} фразам к прежним значениям.` }
  }

  // campaigns.update.negatives: вернуть прежний полный список минус-фраз.
  const beforeList = asStringList(last.before)
  const afterList = asStringList(last.after)
  if (!beforeList || !afterList) {
    return { ok: false, message: 'В записи лога нет корректных before/after — откатить минус-фразы не могу.' }
  }

  const gate = await applyNegativeKeywords(beforeList, afterList, REVERT_REASON, last.id)
  if (!gate.applied) {
    return { ok: false, message: 'Откат минус-фраз не применён: режим наблюдения или стоп-кран. Записал как «сделал бы».' }
  }

  await prisma.borisDirectActionLog.update({
    where: { id: last.id },
    data: { revertedAt: new Date() },
  })
  return { ok: true, message: `Вернул прежний список минус-фраз (${beforeList.length} шт.).` }
}
