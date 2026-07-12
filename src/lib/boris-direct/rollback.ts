/**
 * Откат пишущих действий Бориса-Директа.
 *
 * «Борис, откати последнее» → revertLastAction (последняя applied+не откаченная).
 * Принятая владельцем коррекция (bid_revert / minus_review, М4 ШАГ 5) →
 * revertActionById(actionLogId) по КОНКРЕТНОМУ действию. Обе применяют обратное
 * действие ЧЕРЕЗ write-gate (мимо гейта не ходим): ставки — вернуть before-ставки,
 * минуса — убрать добавленное (added = after − before, ручные правки владельца
 * сохраняются).
 *
 * Откат ставок УВАЖАЕТ level-lock (М4): снимает фиксацию уровня отканных фраз, чтобы
 * следующий тик переустановил их уровень по ТЕКУЩЕМУ вердикту (откат = событие смены
 * уровня, не дрейф), а не вернул прежний уровень по застрявшему локу.
 *
 * keywords.suspend / campaigns.suspend НЕ откатываем автоматически:
 * resume не входит в разрешённый набор операций — только вручную.
 */

import type { BorisDirectActionLog, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { applyBidChanges, removeNegativeKeywords } from './write-gate'
import { normalizePhrase } from './rules'
import { deserializeLevels, serializeLevels, type PhraseLevelSnapshot } from './level-lock'

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

/**
 * М4 ШАГ 5: снять level-lock (kind 'phrase_tv_lock') с отканных фраз — чтобы
 * следующий тик переустановил их уровень по вердикту, а не вернул прежний по локу.
 * Пишем обновлённый снапшот с ТЕМ ЖЕ tickDate (свежий createdAt делает его актуальным
 * для latestSnapshotPayload). Нет лока / нужных ключей нет → no-op.
 */
async function clearLevelLocksForKeys(keywordIds: number[]): Promise<void> {
  if (keywordIds.length === 0) return
  const snap = await prisma.borisDirectSnapshot.findFirst({
    where: { kind: 'phrase_tv_lock' },
    orderBy: [{ tickDate: 'desc' }, { createdAt: 'desc' }],
  })
  if (!snap) return
  const map = deserializeLevels(snap.payload as unknown as PhraseLevelSnapshot)
  let changed = false
  for (const id of keywordIds) if (map.delete(id)) changed = true
  if (!changed) return
  await prisma.borisDirectSnapshot.create({
    data: {
      tickDate: snap.tickDate,
      kind: 'phrase_tv_lock',
      payload: JSON.parse(JSON.stringify(serializeLevels(map))) as Prisma.InputJsonValue,
    },
  })
}

/**
 * Применить ОБРАТНОЕ действие к загруженной записи лога (ставки / минуса) через
 * write-gate. Помечает запись revertedAt при успехе. Для ставок дополнительно
 * снимает level-lock отканных фраз (fail-safe: сбой снятия не отменяет откат).
 */
async function applyRevert(last: BorisDirectActionLog): Promise<RevertResult> {
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
    // A: write отката видим — поэлементные ошибки Директа не проглатываем.
    if (gate.writeErrors?.length) {
      return {
        ok: gate.applied ? true : false,
        message: gate.applied
          ? `Откатил ставки частично: ${gate.writeErrors.join('; ')}. Проверь ставки в кабинете.`
          : `Откат ставок не применился в Директе (ошибки API): ${gate.writeErrors.join('; ')}.`,
      }
    }
    if (!gate.applied) {
      return { ok: false, message: 'Откат ставок не применён: режим наблюдения или стоп-кран. Записал как «сделал бы».' }
    }

    await prisma.borisDirectActionLog.update({
      where: { id: last.id },
      data: { revertedAt: new Date() },
    })
    // М4: откат уровня = событие смены вердикта → снимаем lock отканных фраз.
    try {
      await clearLevelLocksForKeys(changes.map((c) => c.keywordId))
    } catch (err) {
      console.error('[boris-direct/rollback] не снял level-lock отканных фраз', err)
    }
    return { ok: true, message: `Откатил ставки по ${changes.length} фразам к прежним значениям.` }
  }

  // campaigns.update.negatives (B): УДАЛИТЬ из ЖИВОГО списка ровно то, что действие
  // добавило (added = after − before), сохранив ручные правки владельца. Прежний
  // подход «залить before целиком» стирал эти правки — это и был баг B.
  const beforeList = asStringList(last.before)
  const afterList = asStringList(last.after)
  if (!beforeList || !afterList) {
    return { ok: false, message: 'В записи лога нет корректных before/after — откатить минус-фразы не могу.' }
  }

  const beforeKeys = new Set(beforeList.map(normalizePhrase))
  const added = afterList.filter((phrase) => !beforeKeys.has(normalizePhrase(phrase)))
  if (added.length === 0) {
    return { ok: false, message: 'Это действие ничего не добавляло в минус-список — откатывать нечего.' }
  }

  const gate = await removeNegativeKeywords(added, REVERT_REASON, last.id)
  if (gate.aborted) {
    // Fail-safe: живой список не прочитан / подозрительно усох — кабинет не тронут.
    return { ok: false, message: `Откат минусов отменил (fail-safe): ${gate.abortReason}. Живой список кабинета не тронул.` }
  }
  if (gate.writeErrors?.length) {
    return { ok: false, message: `Откат минусов не применился в Директе (ошибки API): ${gate.writeErrors.join('; ')}.` }
  }
  if (gate.removed === 0) {
    // Добавленных фраз в живом списке уже нет (владелец удалил вручную) — состояние
    // уже достигнуто. Помечаем действие откаченным, кабинет не трогаем.
    await prisma.borisDirectActionLog.update({
      where: { id: last.id },
      data: { revertedAt: new Date() },
    })
    return { ok: true, message: 'Добавленных этим действием фраз в живом списке уже нет — пометил откаченным, кабинет не трогаю.' }
  }
  if (!gate.applied) {
    return { ok: false, message: 'Откат минус-фраз не применён: режим наблюдения или стоп-кран. Записал как «сделал бы».' }
  }

  await prisma.borisDirectActionLog.update({
    where: { id: last.id },
    data: { revertedAt: new Date() },
  })
  const warn = gate.verifyMismatch
    ? ' ⚠️ Контрольное чтение кабинета не сошлось — проверь список минус-фраз вручную.'
    : ''
  return {
    ok: true,
    message: `Убрал ${gate.removed} добавленных этим действием фраз из живого списка (ручные правки владельца сохранены).${warn}`,
  }
}

/** «Борис, откати последнее»: последнее применённое и не откаченное действие. */
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

  return applyRevert(last)
}

/**
 * М4 ШАГ 5: откат КОНКРЕТНОГО действия по id (принятая владельцем коррекция
 * bid_revert / minus_review). Та же механика через write-gate; уважает level-lock.
 */
export async function revertActionById(actionLogId: string): Promise<RevertResult> {
  const last = await prisma.borisDirectActionLog.findFirst({
    where: { id: actionLogId, applied: true, revertedAt: null },
  })
  if (!last) {
    return { ok: false, message: 'Действие для отката не найдено или уже откачено.' }
  }
  if (SUSPEND_ACTIONS.includes(last.action)) {
    return {
      ok: false,
      message: `Действие ${last.action} — остановка: возобновление не входит в мой набор операций, включи вручную.`,
    }
  }
  if (!REVERTIBLE_ACTIONS.includes(last.action)) {
    return { ok: false, message: `Действие ${last.action} откатить не могу — нет обратной операции.` }
  }
  return applyRevert(last)
}
