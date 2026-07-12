/**
 * М5 ШАГ 1: прогноз-самокалибровка Бориса — КЛИКИ и РАСХОД на ближайший день.
 *
 * Заявки НЕ прогнозируем (0–2/день — Пуассон, бесполезно). Метод простой и
 * прозрачный, БЕЗ ML: среднее (± дисперсия) по историческим дням ТОГО ЖЕ типа
 * (рабочий/выходной — «weekday-фактор» из workdays) за окно. Свежие дни окна уже
 * отражают ТЕКУЩИЕ ставки, поэтому отдельного множителя ставок не вводим.
 *
 * Прогноз — только ВИДИМОСТЬ: строка в отчёте + детектор слома владельцу. На
 * ставки/минусы/вердикты не влияет (см. runForecastCycle — живёт в cron-роуте,
 * не в мозг-тике; полигон его не исполняет → sim-нейтрально).
 *
 * ЧИСТЫЕ функции здесь; персист/детект/отправка — в orchestration-модуле роутов.
 */

// ---------- Типы ----------

/** Один исторический день кампании (МСК). isWorkday — из workdays.isWorkday. */
export interface DayObservation {
  date: string
  isWorkday: boolean
  clicks: number
  spendRub: number
}

/** Оценка величины: среднее ± σ по n похожим дням. */
export interface ForecastStat {
  mean: number
  std: number
  n: number
}

/** Прогноз на день: либо созрел (числа), либо ещё копится (have/need). */
export type DailyForecast =
  | { maturing: true; have: number; need: number; targetIsWorkday: boolean }
  | { maturing: false; clicks: ForecastStat; spend: ForecastStat; targetIsWorkday: boolean }

/** Факт дня для сверки с прогнозом. */
export interface ForecastActual {
  clicks: number
  spendRub: number
}

/** Слом по одному измерению: факт ушёл за σ-порог И за абсолютный порог. */
export interface DimensionBreak {
  dimension: 'clicks' | 'spend'
  forecast: number
  actual: number
  sigma: number
  direction: 'below' | 'above'
}

// ---------- Расчёт ----------

/** Среднее и σ (популяционная) по выборке; пустая → нули. */
function meanStd(xs: number[]): { mean: number; std: number } {
  if (xs.length === 0) return { mean: 0, std: 0 }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length
  return { mean, std: Math.sqrt(variance) }
}

/**
 * Прогноз на завтра/ближайший день по истории того же типа дня. targetIsWorkday —
 * рабочий ли прогнозируемый день. Похожих дней меньше minDays → «зреет» (детектор
 * молчит, строка честно сообщает, сколько ещё нужно).
 */
export function forecastNextDay(
  history: DayObservation[],
  targetIsWorkday: boolean,
  cfg: { minDays: number }
): DailyForecast {
  const similar = history.filter((d) => d.isWorkday === targetIsWorkday)
  if (similar.length < cfg.minDays) {
    return { maturing: true, have: similar.length, need: cfg.minDays, targetIsWorkday }
  }
  const clicks = meanStd(similar.map((d) => d.clicks))
  const spend = meanStd(similar.map((d) => d.spendRub))
  return {
    maturing: false,
    clicks: { ...clicks, n: similar.length },
    spend: { ...spend, n: similar.length },
    targetIsWorkday,
  }
}

/** Сигма отклонения; std=0 → Inf при любом ненулевом отклонении (решает абсолют-порог). */
function sigmaOf(actual: number, mean: number, std: number): number {
  const dev = Math.abs(actual - mean)
  if (std > 0) return dev / std
  return dev > 0 ? Infinity : 0
}

/**
 * Детектор слома: по каждому измерению слом, если факт ушёл ОДНОВРЕМЕННО за
 * breakSigma сигм И за абсолютный порог (minClicksDev / minSpendDevRub) — чтобы
 * не алертить на «ждал 5, пришло 9». Прогноз «зреет» → пусто (не судим).
 */
export function detectForecastBreak(
  forecast: DailyForecast,
  actual: ForecastActual,
  cfg: { breakSigma: number; minClicksDev: number; minSpendDevRub: number }
): DimensionBreak[] {
  if (forecast.maturing) return []
  const breaks: DimensionBreak[] = []

  const clicksSigma = sigmaOf(actual.clicks, forecast.clicks.mean, forecast.clicks.std)
  const clicksDev = Math.abs(actual.clicks - forecast.clicks.mean)
  if (clicksSigma >= cfg.breakSigma && clicksDev >= cfg.minClicksDev) {
    breaks.push({
      dimension: 'clicks',
      forecast: forecast.clicks.mean,
      actual: actual.clicks,
      sigma: clicksSigma,
      direction: actual.clicks < forecast.clicks.mean ? 'below' : 'above',
    })
  }

  const spendSigma = sigmaOf(actual.spendRub, forecast.spend.mean, forecast.spend.std)
  const spendDev = Math.abs(actual.spendRub - forecast.spend.mean)
  if (spendSigma >= cfg.breakSigma && spendDev >= cfg.minSpendDevRub) {
    breaks.push({
      dimension: 'spend',
      forecast: forecast.spend.mean,
      actual: actual.spendRub,
      sigma: spendSigma,
      direction: actual.spendRub < forecast.spend.mean ? 'below' : 'above',
    })
  }

  return breaks
}

/**
 * Готовая строка прогноз/факт для дневного отчёта (retрospective): либо сверка
 * чисел, либо «зреет», либо null (прогноза за этот день нет — строку не печатаем).
 * Чистая: даёт вызывающему готовый текст (тесты — детерминированно).
 */
export function renderForecastLine(
  forecast: DailyForecast | null,
  actual: ForecastActual
): string | null {
  if (!forecast) return null
  if (forecast.maturing) return formatForecastMaturing(forecast)
  return formatForecastVsActual(forecast, actual)
}

// ---------- Форматирование (голосом Бориса, без LLM) ----------

/** Целое число строкой (без разделителей — LLM переформатирует в отчёте). */
function fmt(n: number): string {
  return String(Math.round(n))
}

/** Строка сверки «ждал X±σ, факт Z» по кликам и расходу (для дневного отчёта). */
export function formatForecastVsActual(
  forecast: Extract<DailyForecast, { maturing: false }>,
  actual: ForecastActual
): string {
  const c = forecast.clicks
  const s = forecast.spend
  return (
    `клики: ждал ${fmt(c.mean)}±${fmt(c.std)}, факт ${fmt(actual.clicks)}; ` +
    `расход: ждал ${fmt(s.mean)}±${fmt(s.std)} ₽, факт ${fmt(actual.spendRub)} ₽`
  )
}

/** Строка «прогноз зреет» с текущим прогрессом (для дневного отчёта). */
export function formatForecastMaturing(
  forecast: Extract<DailyForecast, { maturing: true }>
): string {
  const dayType = forecast.targetIsWorkday ? 'рабочих' : 'выходных'
  return `прогноз зреет: нужно ≥${forecast.need} похожих (${dayType}) дней, есть ${forecast.have}`
}

/**
 * Гипотезы направлений слома для алерта владельцу. Комбинация направлений
 * клики/расход подсказывает причину (аукцион/разметка/сезон) — но это ГИПОТЕЗЫ,
 * не диагноз: последнее слово за владельцем.
 */
export function formatBreakHypotheses(breaks: DimensionBreak[]): string {
  const clicks = breaks.find((b) => b.dimension === 'clicks')
  const spend = breaks.find((b) => b.dimension === 'spend')

  if (clicks?.direction === 'below' && spend?.direction === 'below') {
    return 'обвал трафика: возможно вытеснили в аукционе, слетела разметка/показы или сезонный спад — проверь ставки конкурентов и Метрику'
  }
  if (clicks?.direction === 'below' && spend?.direction === 'above') {
    return 'клик подорожал (аукцион перегрет): меньше кликов дороже — конкуренты подняли ставки'
  }
  if (clicks?.direction === 'above' && spend?.direction === 'above') {
    return 'всплеск трафика: сезонный спрос или конкурент ушёл — расход выше плана, следи за ценой заявки'
  }
  if (clicks?.direction === 'above' && !spend) {
    return 'кликов больше плана при обычном расходе — клик подешевел (конкуренция спала)'
  }
  if (spend?.direction === 'above' && !clicks) {
    return 'расход выше плана при обычных кликах — клик подорожал (аукцион)'
  }
  if (spend?.direction === 'below' && !clicks) {
    return 'расход ниже плана при обычных кликах — клик подешевел или часть показов ушла'
  }
  if (clicks?.direction === 'below' && !spend) {
    return 'кликов меньше плана при обычном расходе — упали показы (разметка/аукцион/сезон)'
  }
  return 'отклонение от прогноза — проверь аукцион, разметку и сезон'
}

// ---------- Оркестрация (I/O: prisma + telegram) ----------
//
// ЖИВЁТ В CRON-РОУТЕ, НЕ В МОЗГ-ТИКЕ. Полигон гоняет runCollectTick/runProcessTick
// напрямую и НЕ вызывает роуты → этот код на sim-скоринг не влияет (sim-нейтрально).
// Всё обёрнуто в try/catch: сбой прогноза НЕ роняет тик (fail-safe).

import { prisma } from '@/lib/db/prisma'
import { mskDay, mskDayStartUtc } from './brain'
import { isWorkday } from './workdays'
import { sendToDirectChat } from './telegram'
import {
  FORECAST_MIN_DAYS,
  FORECAST_WINDOW_DAYS,
  FORECAST_BREAK_SIGMA,
  FORECAST_MIN_CLICKS_DEV,
  FORECAST_MIN_SPEND_DEV_RUB,
} from './config'

const DAY_MS = 24 * 60 * 60 * 1000

interface DailyTotalsSnap {
  date: string
  spendRub: number
  clicks: number
  impressions: number
}

const BREAK_DETECT_CFG = {
  breakSigma: FORECAST_BREAK_SIGMA,
  minClicksDev: FORECAST_MIN_CLICKS_DEV,
  minSpendDevRub: FORECAST_MIN_SPEND_DEV_RUB,
}

/** История дневных итогов за окно (kind='daily_totals') → DayObservation[] с типом дня. */
async function loadHistory(endInclusive: Date): Promise<DayObservation[]> {
  const from = new Date(endInclusive.getTime() - (FORECAST_WINDOW_DAYS - 1) * DAY_MS)
  const snaps = await prisma.borisDirectSnapshot.findMany({
    where: { kind: 'daily_totals', tickDate: { gte: from, lte: endInclusive } },
    orderBy: { createdAt: 'asc' },
  })
  // Дедуп по дню: последняя запись на день побеждает (идемпотентный агрегат).
  const byDay = new Map<string, DailyTotalsSnap>()
  for (const s of snaps) {
    const p = s.payload as unknown as DailyTotalsSnap
    if (p?.date) byDay.set(p.date, p)
  }
  return [...byDay.values()].map((p) => ({
    date: p.date,
    isWorkday: isWorkday(p.date),
    clicks: p.clicks ?? 0,
    spendRub: p.spendRub ?? 0,
  }))
}

/** Прогноз, персиснутый за конкретный МСК-день (kind='forecast_daily'), или null. */
export async function loadForecastForDay(day: string): Promise<DailyForecast | null> {
  try {
    const snap = await prisma.borisDirectSnapshot.findFirst({
      where: { kind: 'forecast_daily', tickDate: mskDayStartUtc(day) },
      orderBy: { createdAt: 'desc' },
    })
    return snap ? (snap.payload as unknown as DailyForecast) : null
  } catch (err) {
    console.error('[boris-direct/forecast] чтение прогноза дня не удалось', err)
    return null
  }
}

/**
 * Суточный цикл прогноза (зовётся из cron-роута «обработка» ПОСЛЕ записи
 * daily_totals за вчера — там свежайшая история и живёт отправка алертов):
 *  1) ДЕТЕКТ: сравнить прогноз@вчера (персиснут позавчера) с фактом@вчера
 *     (daily_totals). Слом (2 порога) → алерт владельцу c гипотезами, 1 раз/день.
 *  2) ГЕНЕРАЦИЯ: спрогнозировать СЕГОДНЯ по истории (вкл. вчера) → персист.
 * FAIL-SAFE: любой сбой логируется, тик живёт дальше.
 */
export async function runForecastCycle(
  now: Date = new Date()
): Promise<{ detected: 'break' | 'ok' | 'skipped'; generated: 'ok' | 'maturing' | 'skipped' }> {
  const today = mskDay(now)
  const yesterday = mskDay(new Date(mskDayStartUtc(today).getTime() - DAY_MS))
  let detected: 'break' | 'ok' | 'skipped' = 'skipped'
  let generated: 'ok' | 'maturing' | 'skipped' = 'skipped'

  // --- 1) ДЕТЕКТ слома за вчера ---
  try {
    const yStart = mskDayStartUtc(yesterday)
    const actualSnap = await prisma.borisDirectSnapshot.findFirst({
      where: { kind: 'daily_totals', tickDate: yStart },
      orderBy: { createdAt: 'desc' },
    })
    const forecastY = await loadForecastForDay(yesterday)
    if (actualSnap && forecastY && !forecastY.maturing) {
      const actual = actualSnap.payload as unknown as DailyTotalsSnap
      const breaks = detectForecastBreak(
        forecastY,
        { clicks: actual.clicks ?? 0, spendRub: actual.spendRub ?? 0 },
        BREAK_DETECT_CFG
      )
      if (breaks.length === 0) {
        detected = 'ok'
      } else {
        // Троттлинг: один алерт слома на день (несколько process-тиков в сутки).
        const already = await prisma.borisDirectSnapshot.findFirst({
          where: { kind: 'forecast_break_alerted', tickDate: yStart },
        })
        if (!already) {
          const parts = breaks.map(
            (b) =>
              `${b.dimension === 'clicks' ? 'клики' : 'расход'}: ждал ${Math.round(b.forecast)}${
                b.dimension === 'spend' ? ' ₽' : ''
              }, факт ${Math.round(b.actual)}${b.dimension === 'spend' ? ' ₽' : ''} (${b.direction === 'below' ? 'ниже' : 'выше'} на ${b.sigma === Infinity ? '∞' : b.sigma.toFixed(1)}σ)`
          )
          const text =
            `⚠️ <b>Слом прогноза за ${yesterday}</b>\n` +
            parts.join('\n') +
            `\nГипотеза: ${formatBreakHypotheses(breaks)}\n` +
            `Это сигнал раньше, чем «ноль заявок» — проверь, не сломалось ли что.`
          await sendToDirectChat(text)
          await prisma.borisDirectSnapshot.create({
            data: {
              tickDate: yStart,
              kind: 'forecast_break_alerted',
              payload: { dimensions: breaks.map((b) => b.dimension) },
            },
          })
        }
        detected = 'break'
      }
    }
  } catch (err) {
    console.error('[boris-direct/forecast] детект слома не удался (тик живёт)', err)
  }

  // --- 2) ГЕНЕРАЦИЯ прогноза на сегодня ---
  try {
    const history = await loadHistory(mskDayStartUtc(today))
    const forecast = forecastNextDay(history, isWorkday(today), { minDays: FORECAST_MIN_DAYS })
    await prisma.borisDirectSnapshot.create({
      data: {
        tickDate: mskDayStartUtc(today),
        kind: 'forecast_daily',
        payload: JSON.parse(JSON.stringify(forecast)),
      },
    })
    generated = forecast.maturing ? 'maturing' : 'ok'
  } catch (err) {
    console.error('[boris-direct/forecast] генерация прогноза не удалась (тик живёт)', err)
  }

  return { detected, generated }
}
