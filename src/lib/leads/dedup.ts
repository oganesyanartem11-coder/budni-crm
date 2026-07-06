import { toZonedTime } from 'date-fns-tz'
import { prisma } from '@/lib/db/prisma'

/**
 * Дедуп ретраев приёмника заявок (/api/leads/intake).
 *
 * Фронт budni.pro шлёт заявку с keepalive + до 2 ретраев и показывает «Спасибо»
 * только на 2xx. Значит один человек может прислать ТУ ЖЕ заявку несколько раз.
 *
 * ВАЖНО: дедупим по факту ДОСТАВКИ в чат, а НЕ по наличию записи в БД. Ретрай
 * существует, чтобы вылечить временный сбой отправки: если прошлая попытка
 * записала лид, но в чат НЕ доставила, ретрай ОБЯЗАН попробовать доставить снова
 * (правило «при сомнении — доставить, дубль лучше молчаливой потери»). Поэтому
 * глушим ретрай ТОЛЬКО когда есть свежая пометка «доставлено» по этому телефону.
 *
 * Пометки/счётчики держим в ActivityLog (миграция не нужна — action произвольный).
 */

/**
 * Окно дедупа — 5 минут. Обоснование: весь ретрай-шторм фронта укладывается
 * в ~30 с (3 попытки × таймаут 8 с + паузы 0.5/1 с); 5 минут даёт ~10× запаса
 * на задержки сети/keepalive и при этом достаточно коротко, чтобы НЕ схлопнуть
 * осознанную повторную заявку того же человека спустя время.
 */
export const DEDUP_WINDOW_MS = 5 * 60 * 1000

/** Троттл honeypot-алёртов — не чаще 1 раза в час (защита от флуда чата ботами). */
export const HONEYPOT_ALERT_WINDOW_MS = 60 * 60 * 1000

const DELIVERED_ACTION = 'LEAD_INTAKE_DELIVERED'
const DEDUP_ACTION = 'LEAD_INTAKE_DEDUPED'
const HONEYPOT_ALERT_ACTION = 'LEAD_HONEYPOT_ALERT'
const MSK_TIMEZONE = 'Europe/Moscow'

/** UTC-полночь текущего МСК-дня (для дневного счётчика, как в daily-summary). */
function mskMidnightUtc(now: Date): Date {
  const m = toZonedTime(now, MSK_TIMEZONE)
  return new Date(Date.UTC(m.getFullYear(), m.getMonth(), m.getDate(), 0, 0, 0, 0))
}

/**
 * Была ли ЗАЯВКА С ЭТИМ phone_digits уже ДОСТАВЛЕНА в чат за окно — т.е. текущий
 * запрос это ретрай уже доставленной заявки, повторять отправку не нужно.
 * Ошибка чтения → null (при сомнении доставляем, не глушим заявку).
 */
export async function findRecentDelivered(
  phoneDigits: string,
  now: Date = new Date()
): Promise<{ id: string } | null> {
  try {
    return await prisma.activityLog.findFirst({
      where: {
        action: DELIVERED_ACTION,
        entityId: phoneDigits,
        createdAt: { gte: new Date(now.getTime() - DEDUP_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
  } catch (err) {
    console.error('[leads/intake] delivered lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Пометка «заявка доставлена в чат» (ставим ТОЛЬКО после успешной отправки). */
export async function recordDelivered(phoneDigits: string): Promise<void> {
  await prisma.activityLog
    .create({
      data: {
        userId: null,
        userRole: 'ADMIN',
        action: DELIVERED_ACTION,
        entityType: 'LeadDelivered',
        entityId: phoneDigits,
      },
    })
    .catch(() => {
      /* пометка не должна ронять приём заявки */
    })
}

/**
 * Есть ли свежая (в окне) запись LandingLead с тем же phone_digits — чтобы при
 * лечащем ретрае (доставки не было) НЕ создавать второй ряд и не завышать сверку.
 * Индекс [phoneDigits] + [createdAt]. Ошибка → null.
 */
export async function findRecentDuplicate(
  phoneDigits: string,
  now: Date = new Date()
): Promise<{ id: string } | null> {
  try {
    return await prisma.landingLead.findFirst({
      where: { phoneDigits, createdAt: { gte: new Date(now.getTime() - DEDUP_WINDOW_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
  } catch (err) {
    console.error('[leads/intake] dedup lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Фиксирует факт отсеянного дубля (счётчик в ActivityLog). Никогда не кидает.
 */
export async function recordDedupDrop(priorId: string, source: string | null): Promise<void> {
  await prisma.activityLog
    .create({
      data: {
        userId: null,
        userRole: 'ADMIN',
        action: DEDUP_ACTION,
        entityType: 'LandingLead',
        entityId: priorId,
        payload: { source: source ?? null },
      },
    })
    .catch(() => {
      /* счётчик не должен ронять приём заявки */
    })
}

/**
 * Сколько дублей-ретраев отсеяно за СЕГОДНЯ (МСК) — для строки в дневной сводке.
 * Ошибка чтения → 0 (статистика не роняет отчёт).
 */
export async function countDedupDropsToday(now: Date = new Date()): Promise<number> {
  try {
    return await prisma.activityLog.count({
      where: { action: DEDUP_ACTION, createdAt: { gte: mskMidnightUtc(now) } },
    })
  } catch {
    return 0
  }
}

/**
 * Троттл honeypot-алёрта: true (и ставит марку), если за последний час алёрта не
 * было; иначе false. Не даёт спам-ботам залить чат Директа и вытеснить реальные
 * алёрты о потере заявок (Telegram 429). Ошибка → false (молчим, не роняем).
 */
export async function throttleHoneypotAlert(now: Date = new Date()): Promise<boolean> {
  try {
    const recent = await prisma.activityLog.findFirst({
      where: {
        action: HONEYPOT_ALERT_ACTION,
        createdAt: { gte: new Date(now.getTime() - HONEYPOT_ALERT_WINDOW_MS) },
      },
      select: { id: true },
    })
    if (recent) return false
    await prisma.activityLog
      .create({
        data: { userId: null, userRole: 'ADMIN', action: HONEYPOT_ALERT_ACTION, entityType: 'HoneypotAlert' },
      })
      .catch(() => {})
    return true
  } catch {
    return false
  }
}
