/**
 * Cron: Борис-Директ, лёгкий интрадей-надзор кампании (несколько раз в день,
 * БЕЗ суточной идемпотентности — это и есть смысл надзора).
 *
 * Проверки (только чтение campaigns.get):
 * - ADD_METRICA_TAG слетел в NO (ломается атрибуция заявок);
 * - State не ON / Status не ACCEPTED (кампания не крутится);
 * - StatusPayment не ALLOWED (показы заблокированы оплатой).
 *
 * Дедуп алёртов в течение дня: снапшоты 'watch_alert' за сегодня-МСК по kind —
 * один и тот же алёрт не спамим на каждом прогоне. Ошибка API Директа →
 * warn-сообщение в чат + ok:false в ответе (heartbeat зафиксирует).
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import type { Prisma } from '@prisma/client'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import {
  getCampaignState,
  getAddMetricaTagValue,
  type CampaignState,
} from '@/lib/boris-direct/direct-client'
import { buildTodaySpendReportBody, pollReport, parseReportTsv } from '@/lib/boris-direct/reports'
import { mskDay, mskDayStartUtc } from '@/lib/boris-direct/brain'
import { sendToDirectChat } from '@/lib/boris-direct/telegram'
import { formatAnomalyMessage } from '@/lib/boris-direct/report-texts'
import { classifyBudgetOveruse, type Anomaly } from '@/lib/boris-direct/anomalies'
import { suspendCampaignEmergency } from '@/lib/boris-direct/write-gate'
import { MICRO, CATASTROPHE_HARD_FACTOR } from '@/lib/boris-direct/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_LABEL = 'boris-direct-watch'

/** Детерминированные проверки состояния кампании → самодельные Anomaly. */
function detectWatchProblems(campaign: CampaignState): Anomaly[] {
  const problems: Anomaly[] = []
  if (getAddMetricaTagValue(campaign) === 'NO') {
    problems.push({
      severity: 'critical',
      kind: 'watch_metrica_tag_off',
      text: 'ADD_METRICA_TAG=NO: разметка ссылок Метрикой слетела — атрибуция заявок ломается, нужно вернуть YES.',
    })
  }
  if (campaign.State !== 'ON') {
    problems.push({
      severity: 'critical',
      kind: 'watch_state',
      text: `Кампания не крутится: State=${campaign.State} (жду ON) — показов нет.`,
    })
  }
  if (campaign.Status !== 'ACCEPTED') {
    problems.push({
      severity: 'critical',
      kind: 'watch_status',
      text: `Кампания не принята модерацией: Status=${campaign.Status} (жду ACCEPTED).`,
    })
  }
  if (campaign.StatusPayment !== 'ALLOWED') {
    problems.push({
      severity: 'critical',
      kind: 'watch_payment',
      text: `Показы заблокированы оплатой: StatusPayment=${campaign.StatusPayment} — проверить баланс.`,
    })
  }
  return problems
}

/** Число из TSV-ячейки расхода: '--'/пусто/мусор → 0. */
function tsvNum(raw: string | undefined): number {
  const v = raw?.trim().replace(',', '.')
  if (!v || v === '--') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Интрадей-расход СЕГОДНЯ (₽) из Reports (DateRangeType=TODAY). Поллинг
 * ограничен (отчёт мелкий — зонд подтвердил готовность за 1 поллинг). Не дозрел
 * или ошибка → null: детектор — ДОПОЛНИТЕЛЬНАЯ сеть, при отсутствии данных НЕ
 * действует (fail-safe = бездействие).
 */
async function fetchTodaySpendRub(now: Date): Promise<number | null> {
  const body = buildTodaySpendReportBody(`bd_today_spend_${now.getTime()}`)
  for (let i = 0; i < 5; i++) {
    const res = await pollReport(body)
    if (res.status === 'ready') {
      return parseReportTsv(res.tsv).reduce((acc, r) => acc + tsvNum(r.Cost), 0)
    }
    if (res.status === 'failed') return null
    await new Promise((r) => setTimeout(r, Math.min(res.retryInSec, 5) * 1000))
  }
  return null
}

export async function handler(_request: Request) {
  const now = new Date()

  let campaign: CampaignState
  try {
    campaign = await getCampaignState()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[cron:${JOB_LABEL}] API Директа недоступен`, err)
    await sendToDirectChat(
      '⚠️ Надзор Директа: API не отвечает, состояние кампании не проверил. Если повторится — смотреть доступы и квоты.'
    )
    return NextResponse.json({ ok: false, error: message })
  }

  const problems = detectWatchProblems(campaign)

  // Дедуп: kind, по которым сегодня-МСК уже улетал алёрт, молчат до завтра.
  const todayTick = mskDayStartUtc(mskDay(now))
  const sentToday = await prisma.borisDirectSnapshot.findMany({
    where: { kind: 'watch_alert', tickDate: todayTick },
    select: { payload: true },
  })
  const alreadyAlerted = new Set(
    sentToday.map((snap) => (snap.payload as unknown as { kind?: string })?.kind ?? '')
  )

  let alerted = 0
  for (const problem of problems) {
    if (alreadyAlerted.has(problem.kind)) continue
    await sendToDirectChat(formatAnomalyMessage(problem))
    await prisma.borisDirectSnapshot.create({
      data: {
        tickDate: todayTick,
        kind: 'watch_alert',
        payload: {
          kind: problem.kind,
          severity: problem.severity,
          text: problem.text,
        } as Prisma.InputJsonValue,
      },
    })
    alerted += 1
  }

  // --- Катастрофа расхода (интрадей): аварийная сеть сверх предохранителя Директа. ---
  // Источник расхода — TODAY-отчёт; DailyBudget — из ЖИВОГО campaigns.get (уже прочитан).
  // FAIL-SAFE: отчёт не получен → НЕ действуем (тихий лог). Уже suspended → suspend no-op.
  let catastrophe: 'none' | 'soft' | 'hard' = 'none'
  let catastropheAlerted = false
  try {
    const budgetMicro = campaign.DailyBudget?.Amount ?? 0
    if (budgetMicro > 0) {
      const spentTodayRub = await fetchTodaySpendRub(now)
      if (spentTodayRub === null) {
        console.warn(`[cron:${JOB_LABEL}] интрадей-расход не получен — катастрофа-детектор пропущен (fail-safe)`)
      } else {
        const budgetRub = Math.round(budgetMicro / MICRO)
        const level = classifyBudgetOveruse({ spentTodayRub, dailyBudgetRub: budgetMicro / MICRO })
        const mskTime = new Date(now.getTime() + 3 * 3600_000).toISOString().slice(11, 16)
        const ratio = (spentTodayRub / (budgetMicro / MICRO)).toFixed(2)
        const saveCatAlert = async (kind: string, text: string) => {
          await prisma.borisDirectSnapshot.create({
            data: {
              tickDate: todayTick,
              kind: 'watch_alert',
              payload: { kind, severity: 'critical', text } as Prisma.InputJsonValue,
            },
          })
        }
        catastrophe = level
        if (level === 'hard') {
          // Суспенд — только если кампания ещё крутится (уже suspended → no-op, не
          // дублируем). Через write-gate → ActionLog + зрячесть к ошибкам API (спринт A).
          if (campaign.State === 'ON') {
            const gate = await suspendCampaignEmergency(
              `катастрофа расхода: ${spentTodayRub.toFixed(0)} ₽ ≥ ${CATASTROPHE_HARD_FACTOR}× бюджета ${budgetRub} ₽ (интрадей ${mskTime} МСК)`
            )
            if (!alreadyAlerted.has('catastrophe_hard')) {
              const head = gate.applied
                ? '🚨 Кампания ОСТАНОВЛЕНА АВАРИЙНО'
                : '🚨 Катастрофа расхода — остановку записал «сделал бы» (наблюдение/стоп-кран, кампания НЕ остановлена)'
              const errNote = gate.writeErrors?.length
                ? ` ⚠️ остановка вернула ошибку API: ${gate.writeErrors.join('; ')}`
                : ''
              await sendToDirectChat(
                `${head}: расход ${spentTodayRub.toFixed(0)} ₽ при бюджете ${budgetRub} ₽ (${ratio}× ≥ ${CATASTROPHE_HARD_FACTOR}×) на ${mskTime} МСК. ` +
                  `Возобновление — только владелец (в интерфейсе Директа); «Борис, статус» покажет состояние.${errNote}`
              )
              catastropheAlerted = true
              // Дедуп-снапшот ставим ТОЛЬКО при УСПЕШНОЙ остановке. Если suspend не
              // применился (ошибка API / наблюдение) — кампания всё ещё жжёт бюджет,
              // и на следующем watch нужен ПОВТОРНЫЙ алерт (эскалация): дедуп не пишем.
              // Успешный suspend переведёт State в SUSPENDED → дублей suspend всё равно нет.
              if (gate.applied) {
                await saveCatAlert('catastrophe_hard', `расход ${spentTodayRub.toFixed(0)} ≥ ${CATASTROPHE_HARD_FACTOR}× ${budgetRub}`)
              }
            }
          }
        } else if (level === 'soft') {
          // Мягкий: только алерт владельцу, БЕЗ действий; не чаще 1 раза в день.
          if (!alreadyAlerted.has('catastrophe_soft')) {
            await sendToDirectChat(
              `⚠️ Расход достиг дневного бюджета: ${spentTodayRub.toFixed(0)} ₽ ≥ ${budgetRub} ₽ (${ratio}×) на ${mskTime} МСК — слежу, действий пока не предпринимаю.`
            )
            await saveCatAlert('catastrophe_soft', `расход ${spentTodayRub.toFixed(0)} ≥ ${budgetRub}`)
            catastropheAlerted = true
          }
        }
      }
    }
  } catch (err) {
    console.error(`[cron:${JOB_LABEL}] катастрофа-детектор упал (fail-safe, без действий)`, err)
  }

  return NextResponse.json({
    ok: true,
    problems: problems.length,
    alerted,
    deduped: problems.length - alerted,
    catastrophe,
    catastropheAlerted,
  })
}

export const GET = withCronHeartbeat(JOB_LABEL, handler)
