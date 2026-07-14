/**
 * КОНТУР №0 — оркестратор детекторов (спринт 14.07). Живёт в РОУТЕ
 * (boris-direct-process), НЕ в мозг-тике, который гоняет полигон — поэтому только
 * ЧИТАЕТ снапшоты/один отчёт, гоняет ЧИСТЫЕ детекторы и ШЛЁТ алерты владельцу.
 * Ставки/минусы/вердикты не трогает. Полигон его не исполняет → sim-нейтрально
 * (как runForecastCycle). Каждый блок fail-safe: сбой одного детектора не роняет
 * остальные и не роняет тик.
 *
 * Детекторы:
 *  - ВОРОНКА МЕРТВА (funnel.ts) — визиты Метрики живы, цель 0 подряд (главный);
 *  - ЗАСУХА ДИРЕКТА (funnel.ts) — клики есть, Директ-конверсий 0 подряд;
 *  - CPC ВЫШЕ ПОТОЛКА (cpc-audit.ts) — списание за клик пробивает потолок 400 ₽;
 *  - ДРЕЙФ ЛЕСЕНКИ (ladder-drift.ts) — сдвиг медианы входа/доли ниже входа;
 *  - ТРЕНД ПОЗИЦИИ (ladder-drift.ts) — «давно копящаяся» позиция клика/TV.
 *
 * Один read-отчёт Директа/тик (criterion-history за окно) кормит засуху+CPC+позицию;
 * снапшоты — воронку (metrika_goal) и дрейф лесенки (keywordbids). Units бережём.
 */

import { prisma } from '@/lib/db/prisma'
import { mskDay, mskDayStartUtc } from './brain'
import { workdayWindowStartUtc } from './workdays'
import { sendToDirectChat } from './telegram'
import { buildCriterionHistoryReportBody, pollReport, parseReportTsv } from './reports'
import { readReportConversions, parseCriterionId } from './attribution'
import { detectFunnelDeath, detectDirectDrought, type HistCrRow } from './funnel'
import { auditCpc } from './cpc-audit'
import {
  summarizeLadderEntry,
  detectLadderDrift,
  summarizePositionTrend,
  type PositionDayRow,
} from './ladder-drift'
import type { KeywordBidRecord } from './direct-client'
import type { KeywordRecord } from './direct-client'
import { formatAnomalyMessage } from './report-texts'
import { FUNNEL_CR_WINDOW_DAYS, PHRASE_ECON_WINDOW_DAYS, LADDER_DRIFT_WORKDAYS } from './config'

const DAY_MS = 24 * 60 * 60 * 1000

/** Разобранная строка criterion-history за день по ключу. */
interface HistRow {
  date: string
  criterionId: number | null
  clicks: number
  costRub: number
  conversions: number
  avgTrafficVolume: number
  avgClickPosition: number
}

function tsvNum(raw: string | undefined): number {
  const v = raw?.trim()
  if (!v || v === '--') return 0
  const n = Number(v.replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

/**
 * Эфемерный criterion-history отчёт [dateFrom..dateTo] (read-only, БЕЗ записи
 * BorisDirectReportJob). null при невозможности назвать числа (не готов/ошибка/сеть).
 */
async function fetchCriterionHistory(dateFrom: string, dateTo: string): Promise<HistRow[] | null> {
  const compact = `${dateFrom.replace(/-/g, '')}_${dateTo.replace(/-/g, '')}`
  const body = buildCriterionHistoryReportBody(dateFrom, dateTo, `bd_det_${compact}_${dateTo.replace(/-/g, '')}`)
  const MAX_ATTEMPTS = 5
  const MAX_WAIT_SEC = 10
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let poll
    try {
      poll = await pollReport(body)
    } catch (err) {
      console.error('[boris-direct/detector-cycle] criterion-history: сеть упала', err)
      return null
    }
    if (poll.status === 'ready') {
      return parseReportTsv(poll.tsv).map((r) => ({
        date: (r.Date ?? '').trim(),
        criterionId: parseCriterionId(r.CriterionId),
        clicks: tsvNum(r.Clicks),
        costRub: tsvNum(r.Cost),
        conversions: readReportConversions(r),
        avgTrafficVolume: tsvNum(r.AvgTrafficVolume),
        avgClickPosition: tsvNum(r.AvgClickPosition),
      }))
    }
    if (poll.status === 'failed') {
      console.error(`[boris-direct/detector-cycle] criterion-history failed — ${poll.error}`)
      return null
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(poll.retryInSec, MAX_WAIT_SEC) * 1000))
    }
  }
  return null
}

/** Последний снапшот kind (или за конкретный день, если tickDate задан). */
async function snapshotPayload<T>(kind: string, atOrBefore?: Date): Promise<T | null> {
  const snap = await prisma.borisDirectSnapshot.findFirst({
    where: atOrBefore ? { kind, tickDate: { lte: atOrBefore } } : { kind },
    orderBy: [{ tickDate: 'desc' }, { createdAt: 'desc' }],
  })
  return snap ? (snap.payload as unknown as T) : null
}

/** Окно снапшотов metrika_goal → ряд {day, visits, goalReaches} (дедуп по дню). */
async function loadMetrikaWindow(fromTick: Date, toTick: Date): Promise<
  Array<{ day: string; visits: number; goalReaches: number }>
> {
  const snaps = await prisma.borisDirectSnapshot.findMany({
    where: { kind: 'metrika_goal', tickDate: { gte: fromTick, lte: toTick } },
    orderBy: { createdAt: 'asc' },
  })
  const byDay = new Map<string, { visits: number; goalReaches: number }>()
  for (const s of snaps) {
    const rows = (s.payload as unknown as Array<{ date?: string; visits?: number; goalReaches?: number }>) ?? []
    for (const r of rows) {
      if (!r.date) continue
      byDay.set(r.date, { visits: r.visits ?? 0, goalReaches: r.goalReaches ?? 0 })
    }
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({ day, ...v }))
}

export interface DetectorCycleResult {
  alertsSent: number
  ran: string[]
  /** Тексты алертов дня (для дашборда аналитика — рассуждающий контур читает их). */
  alerts: string[]
}

/**
 * Здоровый префикс серии для базовой конверсии: дни до и включая ПОСЛЕДНИЙ день с
 * успехом (успех = successOf(d) > 0). Так базовая CR не отравляется текущим
 * нулём-обрывом (иначе CR падает и P0 растёт — детектор глушит сам себя во время
 * длящегося обрыва). Нет ни одного успеха → пусто (никогда не конвертило → судить
 * нечем, детектор молчит).
 */
function healthyPrefix<T>(series: T[], successOf: (d: T) => number): T[] {
  let lastSuccess = -1
  for (let i = 0; i < series.length; i++) {
    if (successOf(series[i]) > 0) lastSuccess = i
  }
  return lastSuccess >= 0 ? series.slice(0, lastSuccess + 1) : []
}

/**
 * Прогон контура №0. FAIL-SAFE по блокам: сбой одного детектора не мешает другим.
 * Возвращает счётчик отправленных алертов (для лога роута/теста).
 */
export async function runDetectorCycle(now: Date = new Date()): Promise<DetectorCycleResult> {
  const today = mskDay(now)
  const yesterday = mskDay(new Date(mskDayStartUtc(today).getTime() - DAY_MS))
  const ran: string[] = []
  const toSend: string[] = []

  // --- 1) ВОРОНКА МЕРТВА (визиты Метрики живы, цель 0) ---
  try {
    const fromTick = new Date(mskDayStartUtc(yesterday).getTime() - (FUNNEL_CR_WINDOW_DAYS - 1) * DAY_MS)
    const series = await loadMetrikaWindow(fromTick, mskDayStartUtc(yesterday))
    if (series.length > 0) {
      // Базовая CR — по здоровому префиксу (до текущего нуля), иначе обрыв топит CR.
      const histWindow: HistCrRow[] = healthyPrefix(series, (d) => d.goalReaches).map((d) => ({
        visits: d.visits,
        goalReaches: d.goalReaches,
      }))
      const alert = detectFunnelDeath({ series, histWindow })
      if (alert) toSend.push(formatAnomalyMessage(alert))
      ran.push('funnel')
    }
  } catch (err) {
    console.error('[boris-direct/detector-cycle] воронка: сбой (тик живёт)', err)
  }

  // --- Один отчёт criterion-history за окно (кормит засуху + CPC + позицию) ---
  let hist: HistRow[] | null = null
  try {
    const windowFrom = mskDay(new Date(mskDayStartUtc(yesterday).getTime() - (PHRASE_ECON_WINDOW_DAYS - 1) * DAY_MS))
    hist = await fetchCriterionHistory(windowFrom, yesterday)
  } catch (err) {
    console.error('[boris-direct/detector-cycle] отчёт истории не получен (тик живёт)', err)
  }

  if (hist && hist.length > 0) {
    // --- 2) ЗАСУХА ДИРЕКТА (клики есть, Директ-конверсий 0) ---
    try {
      const byDay = new Map<string, { clicks: number; conversions: number }>()
      for (const r of hist) {
        const d = byDay.get(r.date) ?? { clicks: 0, conversions: 0 }
        d.clicks += r.clicks
        d.conversions += r.conversions
        byDay.set(r.date, d)
      }
      const droughtSeries = [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, v]) => ({ day, ...v }))
      // Базовая CR Директа — по здоровому префиксу (до текущей засухи), не по всему
      // окну (иначе дни-обрыва топят CR и P0 растёт). Нет здоровых конверсий → 0
      // (детектор возьмёт дефолтный prior).
      const healthy = healthyPrefix(droughtSeries, (d) => d.conversions)
      const hClicks = healthy.reduce((s, d) => s + d.clicks, 0)
      const hConv = healthy.reduce((s, d) => s + d.conversions, 0)
      const campaignCr = hClicks > 0 ? hConv / hClicks : 0
      const alert = detectDirectDrought({ series: droughtSeries, campaignCr })
      if (alert) toSend.push(formatAnomalyMessage(alert))
      ran.push('drought')
    } catch (err) {
      console.error('[boris-direct/detector-cycle] засуха: сбой (тик живёт)', err)
    }

    // --- 3) CPC ВЫШЕ ПОТОЛКА (по строкам ВЧЕРА, ключ → текст фразы) ---
    try {
      const keywords = (await snapshotPayload<KeywordRecord[]>('keywords')) ?? []
      const textById = new Map(keywords.map((k) => [k.Id, k.Keyword]))
      const yByCrit = new Map<number, { clicks: number; costRub: number }>()
      for (const r of hist) {
        if (r.date !== yesterday || r.criterionId == null) continue
        const cur = yByCrit.get(r.criterionId) ?? { clicks: 0, costRub: 0 }
        cur.clicks += r.clicks
        cur.costRub += r.costRub
        yByCrit.set(r.criterionId, cur)
      }
      const rows = [...yByCrit.entries()].map(([id, v]) => ({
        key: textById.get(id) ?? `#${id}`,
        clicks: v.clicks,
        costRub: v.costRub,
        date: yesterday,
      }))
      const audit = auditCpc(rows)
      if (audit.alert) toSend.push(formatAnomalyMessage(audit.alert))
      ran.push('cpc')
    } catch (err) {
      console.error('[boris-direct/detector-cycle] CPC: сбой (тик живёт)', err)
    }

    // --- 5) ТРЕНД ПОЗИЦИИ (информативно; шлём ТОЛЬКО при ухудшении) ---
    // Внутри тика анти-спам держат worsening-гейт + порог POSITION_TREND_DELTA=1.
    // Кросс-дневного cooldown НЕТ: при затяжном ухудшении алерт повторится раз в
    // день (тик 1/день по alreadyRanToday), как и остальные аномалии кодовой базы.
    // Персист-cooldown «last alerted» — задел спринта 2 (рассуждающий контур).
    try {
      const posRows: PositionDayRow[] = hist
        .filter((r) => r.clicks > 0)
        .map((r) => ({
          day: r.date,
          clicks: r.clicks,
          avgClickPosition: r.avgClickPosition,
          avgTrafficVolume: r.avgTrafficVolume,
        }))
      const trend = summarizePositionTrend(posRows)
      if (trend.trend === 'worsening' && trend.days.length >= 2) {
        const first = trend.days[0]
        const last = trend.days[trend.days.length - 1]
        toSend.push(
          `⚠️ [ПОЗИЦИЯ] позиция клика ухудшается за окно: ` +
            `${first.weightedPosition.toFixed(1)} (${first.day}) → ${last.weightedPosition.toFixed(1)} (${last.day}); ` +
            `выкупаемый объём TV ${Math.round(first.weightedTv)}→${Math.round(last.weightedTv)}. ` +
            `Сверься с дрейфом лесенки и ставками.`
        )
      }
      ran.push('position')
    } catch (err) {
      console.error('[boris-direct/detector-cycle] позиция: сбой (тик живёт)', err)
    }
  }

  // --- 4) ДРЕЙФ ЛЕСЕНКИ (снапшот keywordbids сегодня vs N рабочих дней назад) ---
  try {
    const todayBids = await snapshotPayload<KeywordBidRecord[]>('keywordbids')
    // pastTick якорим на СЕГОДНЯ (тик «сбор» пишет keywordbids сегодня утром до
    // «обработки», так что todayBids — сегодняшний): span ровно LADDER_DRIFT_WORKDAYS
    // рабочих дней. Если сегодняшний снапшот ещё не записан (collect упал/сдвинут) —
    // todayBids откатится к вчерашнему, окно лишь СУЖАЕТСЯ (не даёт ложных тревог:
    // более короткое окно способно только НЕДООценить дрейф).
    const pastTick = workdayWindowStartUtc(today, LADDER_DRIFT_WORKDAYS)
    const pastBids = await snapshotPayload<KeywordBidRecord[]>('keywordbids', pastTick)
    if (todayBids && pastBids) {
      const drift = detectLadderDrift({
        today: summarizeLadderEntry(todayBids),
        past: summarizeLadderEntry(pastBids),
      })
      if (drift.alert) toSend.push(formatAnomalyMessage(drift.alert))
      ran.push('ladder')
    }
  } catch (err) {
    console.error('[boris-direct/detector-cycle] дрейф лесенки: сбой (тик живёт)', err)
  }

  // --- Отправка (каждый алерт — отдельным сообщением, как аномалии) ---
  let alertsSent = 0
  for (const text of toSend) {
    try {
      await sendToDirectChat(text)
      alertsSent++
    } catch (err) {
      console.error('[boris-direct/detector-cycle] отправка алерта не удалась', err)
    }
  }

  return { alertsSent, ran, alerts: toSend }
}
