import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { prismaDirect } from '@/lib/db/prisma-direct'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import { notifyGroup, escapeHtml } from '@/lib/telegram/notify'
import { getMenuStructureFromImport } from '@/lib/menu-import/expand-menu'
import { findActiveMenuForExtension, extendMenuPlan } from '@/lib/menu-import/extend-menu'

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

function addDaysUtc(d: Date, n: number): Date {
  const r = new Date(d)
  r.setUTCDate(r.getUTCDate() + n)
  return r
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function formatDateRu(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  return `${dd}.${mm}.${yyyy}`
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  const expectedSecret = process.env.CRON_SECRET

  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  if (authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

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

        // Стартовый понедельник нового блока = воскресенье последнего цикла + 1.
        const newStartMonday = addDaysUtc(active.lastValidTo, 1)
        if (newStartMonday.getUTCDay() !== 1) {
          // Защита от багов в Спринте 8.7a: если validTo был не воскресенье,
          // прерываемся и логируем — не вставляем испорченные циклы.
          return {
            action: 'error' as const,
            reason: `lastValidTo=${isoDate(active.lastValidTo)} → next day is not Monday (got dayOfWeek=${newStartMonday.getUTCDay()})`,
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
          newStartMonday,
          EXTEND_WEEKS,
          active.menuImportId,
          null, // approvedById: cron не от имени пользователя
          startOffset,
          tx
        )

        const newHorizon = addDaysUtc(newStartMonday, EXTEND_WEEKS * 7 - 1)
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
