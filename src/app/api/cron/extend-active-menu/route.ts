import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { prismaDirect } from '@/lib/db/prisma-direct'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import { notifyGroup, escapeHtml } from '@/lib/telegram/notify'
import { getMenuStructureFromImport } from '@/lib/menu-import/expand-menu'
import { findActiveMenuForExtension, extendMenuPlan } from '@/lib/menu-import/extend-menu'
import { getMondayOfWeek } from '@/lib/utils/week'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export const dynamic = 'force-dynamic'

const ACTION = 'MENU_AUTO_EXTENDED'
const LOG_PREFIX = '[extend-active-menu]'

/**
 * За сколько дней до конца текущего меню начинаем продлевать.
 * 14 = две недели — у клиентов и менеджеров достаточно времени увидеть
 * новые циклы до того, как старые истекут.
 */
const HORIZON_THRESHOLD_DAYS = 14

/** На сколько недель продлевать. Совпадает с APPROVE_WEEKS_AHEAD (~3 месяца). */
const EXTEND_WEEKS = 13

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime()
  return Math.round(ms / (24 * 60 * 60 * 1000))
}

function isoDate(d: Date): string {
  // MSK-календарная YYYY-MM-DD из произвольной UTC-точки (для логов и payload).
  return new Date(d.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10)
}

function formatDateRu(d: Date): string {
  const shifted = new Date(d.getTime() + MSK_OFFSET_MS)
  const dd = String(shifted.getUTCDate()).padStart(2, '0')
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = shifted.getUTCFullYear()
  return `${dd}.${mm}.${yyyy}`
}

async function handler(_request: Request) {
  const now = new Date()
  const todayMsk = mskMidnightUtc(now, 0)

  // Идемпотентность в пределах суток МСК. Cron вызывается раз в день, но при
  // ручном повторе через Vercel или curl с правильным секретом — не плодим
  // дубль-продление.
  const alreadyRan = await prisma.activityLog.findFirst({
    where: { action: ACTION, createdAt: { gte: todayMsk } },
    select: { id: true },
  })
  if (alreadyRan) {
    console.log(`${LOG_PREFIX} skip: already ran today`)
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_today' })
  }

  // Вся работа в одной транзакции — поиск активного меню, структура, продление.
  // prismaDirect (а не prisma) обходит pgbouncer P2028 для длинных транзакций.
  type ExtendResult =
    | { action: 'no_menu' }
    | { action: 'no_op'; menuImportId: string; horizon: Date; daysLeft: number }
    | { action: 'extended'; menuImportId: string; oldHorizon: Date; newHorizon: Date; cyclesCreated: number }
    | { action: 'error'; reason: string }

  let result: ExtendResult
  try {
    result = await prismaDirect.$transaction<ExtendResult>(
      async (tx) => {
        const active = await findActiveMenuForExtension(tx)
        if (!active) {
          return { action: 'no_menu' as const }
        }

        const daysLeft = daysBetween(todayMsk, active.lastValidTo)
        if (daysLeft > HORIZON_THRESHOLD_DAYS) {
          return {
            action: 'no_op' as const,
            menuImportId: active.menuImportId,
            horizon: active.lastValidTo,
            daysLeft,
          }
        }

        // Стартовый понедельник нового блока = MSK-понедельник следующий за
        // воскресеньем последнего цикла. lastValidTo по новой семантике (7.6 A.1) —
        // MSK Вс 23:59:59.999 как UTC-точка; +1 мс → начало MSK-понедельника
        // следующей недели; getMondayOfWeek нормализует до его MSK-полночи.
        const nextMonday = getMondayOfWeek(new Date(active.lastValidTo.getTime() + 1))
        if (getMondayOfWeek(nextMonday).getTime() !== nextMonday.getTime()) {
          // Defensive: после нормализации всегда совпадёт, но проверка остаётся
          // на случай экстремального дрейфа lastValidTo (например ручная правка).
          return {
            action: 'error' as const,
            reason: `lastValidTo=${isoDate(active.lastValidTo)} → нормализация дала не-MSK-полночь`,
          }
        }

        const structure = await getMenuStructureFromImport(active.menuImportId, tx)
        if (structure.weekA.days.length === 0) {
          return {
            action: 'error' as const,
            reason: `structure is empty for menuImportId=${active.menuImportId}`,
          }
        }

        // Чередование A/B продолжается: если уже было N циклов и N чётное,
        // последний был Б (индекс N-1 нечётный) → новый блок начинается с А
        // (startOffset=0). Если N нечётное — последний был А → новый блок с Б
        // (startOffset=1).
        const startOffset: 0 | 1 = (active.cyclesCount % 2) as 0 | 1

        const cyclesCreated = await extendMenuPlan(
          structure,
          nextMonday,
          EXTEND_WEEKS,
          active.menuImportId,
          null, // approvedById: cron не от имени пользователя
          startOffset,
          tx
        )

        // newHorizon = последний день блока (Вс конца последней недели в MSK).
        // EXTEND_WEEKS недель × 7 дней − 1 день; на UTC-точке это просто +ms.
        const newHorizon = new Date(nextMonday.getTime() + (EXTEND_WEEKS * 7 - 1) * DAY_MS)
        return {
          action: 'extended' as const,
          menuImportId: active.menuImportId,
          oldHorizon: active.lastValidTo,
          newHorizon,
          cyclesCreated,
        }
      },
      { timeout: 30000 }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`${LOG_PREFIX} transaction failed: ${msg}`)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }

  // ──────────────────────────────────────────────────────────────────────
  // Логи + ActivityLog + опциональный Telegram-пуш
  // ──────────────────────────────────────────────────────────────────────

  if (result.action === 'no_menu') {
    console.log(`${LOG_PREFIX} no APPROVED MenuImport found — nothing to extend`)
    await prisma.activityLog.create({
      data: {
        userId: null,
        userRole: 'ADMIN',
        action: ACTION,
        entityType: 'System',
        entityId: isoDate(todayMsk),
        payload: { action: 'no_menu' },
      },
    })
    return NextResponse.json({ ok: true, action: 'no_menu' })
  }

  if (result.action === 'no_op') {
    console.log(
      `${LOG_PREFIX} no-op: horizon=${isoDate(result.horizon)} daysLeft=${result.daysLeft} ` +
        `(threshold=${HORIZON_THRESHOLD_DAYS})`
    )
    await prisma.activityLog.create({
      data: {
        userId: null,
        userRole: 'ADMIN',
        action: ACTION,
        entityType: 'MenuImport',
        entityId: result.menuImportId,
        payload: {
          action: 'no_op',
          horizon: isoDate(result.horizon),
          daysLeft: result.daysLeft,
        },
      },
    })
    return NextResponse.json({
      ok: true,
      action: 'no_op',
      menuImportId: result.menuImportId,
      horizon: isoDate(result.horizon),
      daysLeft: result.daysLeft,
    })
  }

  if (result.action === 'error') {
    console.error(`${LOG_PREFIX} ${result.reason}`)
    await prisma.activityLog.create({
      data: {
        userId: null,
        userRole: 'ADMIN',
        action: ACTION,
        entityType: 'System',
        entityId: isoDate(todayMsk),
        payload: { action: 'error', reason: result.reason },
      },
    })
    return NextResponse.json({ ok: false, action: 'error', reason: result.reason }, { status: 500 })
  }

  // action === 'extended'
  console.log(
    `${LOG_PREFIX} extended menuImportId=${result.menuImportId} ` +
      `oldHorizon=${isoDate(result.oldHorizon)} newHorizon=${isoDate(result.newHorizon)} ` +
      `cyclesCreated=${result.cyclesCreated}`
  )

  const text =
    `🔄 <b>Меню автоматически продлено</b> на ${EXTEND_WEEKS} недель.\n` +
    `Новый горизонт: ${escapeHtml(formatDateRu(result.newHorizon))}`
  const tg = await notifyGroup(text, { parseMode: 'HTML' })
  if (!tg.ok) {
    console.error(`${LOG_PREFIX} notifyGroup failed: ${tg.error}`)
  }

  await prisma.activityLog.create({
    data: {
      userId: null,
      userRole: 'ADMIN',
      action: ACTION,
      entityType: 'MenuImport',
      entityId: result.menuImportId,
      payload: {
        action: 'extended',
        oldHorizon: isoDate(result.oldHorizon),
        newHorizon: isoDate(result.newHorizon),
        cyclesCreated: result.cyclesCreated,
        weeksAdded: EXTEND_WEEKS,
        sentToGroup: tg.ok,
        telegramError: tg.error ?? null,
      },
    },
  })

  return NextResponse.json({
    ok: true,
    action: 'extended',
    menuImportId: result.menuImportId,
    oldHorizon: isoDate(result.oldHorizon),
    newHorizon: isoDate(result.newHorizon),
    cyclesCreated: result.cyclesCreated,
    sentToGroup: tg.ok,
    telegramError: tg.error ?? null,
  })
}

export const GET = withCronHeartbeat('extend-active-menu', handler)
