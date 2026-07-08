/**
 * Cron: Борис-Директ, тик «обработка» (днём, НЕСКОЛЬКО попыток в расписании —
 * отчёты Директа дозревают не сразу).
 *
 * Логика:
 * 1. Идемпотентность на сутки ОБЯЗАТЕЛЬНА (несколько попыток в день).
 * 2. runProcessTick: waiting_report → выходим БЕЗ markRanToday (следующая
 *    попытка дожмёт); done|quarantine → полный пост-процессинг:
 *    предложения → вердикты (со связкой на minus_words-предложение) →
 *    снапшот 'daily_result' для дневного отчёта → применение принятых →
 *    протухание предложений → оффер снятия гейта → аномалии в чат → markRanToday.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import type { Prisma } from '@prisma/client'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { runProcessTick, mskDayStartUtc } from '@/lib/boris-direct/brain'
import {
  createProposal,
  expireStaleProposals,
  formatProposalSummary,
} from '@/lib/boris-direct/proposals'
import {
  recordVerdicts,
  getLearningStats,
  shouldOfferGateLift,
  buildGateLiftProposalInput,
} from '@/lib/boris-direct/learning'
import { applyAcceptedProposals } from '@/lib/boris-direct/apply-accepted'
import { getDirectRoleState } from '@/lib/boris-direct/state'
import { sendToDirectChat } from '@/lib/boris-direct/telegram'
import { formatAnomalyMessage } from '@/lib/boris-direct/report-texts'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_LABEL = 'boris-direct-process'

async function handler(request: Request) {
  const force = new URL(request.url).searchParams.get('force') === 'true'

  // Расписание с несколькими попытками в день: без гарда каждый успешный
  // прогон дублировал бы снапшоты, вердикты и применение принятого.
  if (!force && (await alreadyRanToday(JOB_LABEL))) {
    return NextResponse.json({ ok: true, skipped: 'already_ran' })
  }

  const result = await runProcessTick()

  if (result.status === 'waiting_report') {
    // Отчёты Директа не дозрели. markRanToday НЕ зовём — следующая попытка дожмёт.
    return NextResponse.json({ ok: true, waiting: true })
  }

  // --- Предложения владельцу (до вердиктов: нужна связка verdicts↔proposal). ---
  const proposalsCreated: string[] = []
  let minusProposalId: string | null = null
  for (const draft of result.proposalDrafts) {
    try {
      const created = await createProposal(draft)
      if (!created.created) {
        // Дедуп по PENDING или cooldown после отказа — штатно, просто лог.
        console.log(`[cron:${JOB_LABEL}] предложение ${draft.topicKey} не создано: ${created.reason}`)
        continue
      }
      // formatProposalSummary для minus_words читает payload.words, драфт мозга
      // кладёт phrases — подставляем для человекочитаемого имени.
      const p = draft.payload as Record<string, unknown> | null
      const summaryPayload =
        draft.type === 'minus_words' && p && Array.isArray(p.phrases)
          ? { words: p.phrases }
          : draft.payload
      proposalsCreated.push(formatProposalSummary(draft.type, summaryPayload))

      if (draft.type === 'minus_words') {
        // createProposal не возвращает id — берём свежесозданный PENDING по topicKey.
        const row = await prisma.borisDirectProposal.findFirst({
          where: { topicKey: draft.topicKey, status: 'PENDING' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        })
        minusProposalId = row?.id ?? null
      }
    } catch (err) {
      console.error(`[cron:${JOB_LABEL}] создание предложения ${draft.topicKey} упало`, err)
    }
  }

  // --- Вердикты по спорным минусам: со ссылкой на предложение (обучение). ---
  if (result.verdicts.length > 0) {
    try {
      await recordVerdicts(result.verdicts, minusProposalId)
    } catch (err) {
      console.error(`[cron:${JOB_LABEL}] запись вердиктов упала`, err)
    }
  }

  // --- Снапшот дневного результата — из него потом дневной отчёт. ---
  if (result.reportData) {
    try {
      await prisma.borisDirectSnapshot.create({
        data: {
          tickDate: mskDayStartUtc(result.reportData.dateLabel),
          kind: 'daily_result',
          payload: JSON.parse(
            JSON.stringify({
              ...result.reportData,
              appliedSummaries: result.appliedSummaries,
              wouldDoSummaries: result.wouldDoSummaries,
              proposalsCreated,
            })
          ) as Prisma.InputJsonValue,
        },
      })
    } catch (err) {
      console.error(`[cron:${JOB_LABEL}] снапшот daily_result не записался`, err)
    }
  }

  // --- Принятые владельцем предложения → применение. ---
  let acceptedApplied: string[] = []
  let acceptedSkipped: string[] = []
  let acceptedAlerts: string[] = []
  try {
    const accepted = await applyAcceptedProposals()
    acceptedApplied = accepted.applied
    acceptedSkipped = accepted.skipped
    acceptedAlerts = accepted.alerts
  } catch (err) {
    console.error(`[cron:${JOB_LABEL}] применение принятых предложений упало`, err)
  }

  // --- Протухшие предложения (PENDING старше TTL → EXPIRED). ---
  try {
    await expireStaleProposals()
  } catch (err) {
    console.error(`[cron:${JOB_LABEL}] expireStaleProposals упал`, err)
  }

  // --- Обучение созрело и гейт спорных минусов ещё стоит → предложить снять. ---
  try {
    const stats = await getLearningStats()
    const state = await getDirectRoleState()
    if (shouldOfferGateLift(stats) && state.autoNegativesEnabled === false) {
      await createProposal(buildGateLiftProposalInput(stats))
    }
  } catch (err) {
    console.error(`[cron:${JOB_LABEL}] оффер снятия гейта упал`, err)
  }

  // --- Аномалии тика — владельцу немедленно, не ждут дневного отчёта. ---
  for (const anomaly of result.anomalies) {
    await sendToDirectChat(formatAnomalyMessage(anomaly))
  }

  // --- Fail-safe/рассинхрон-алёрты применения принятых минусов — сразу владельцу. ---
  for (const alert of acceptedAlerts) {
    await sendToDirectChat(alert)
  }

  await markRanToday(JOB_LABEL, {
    status: result.status,
    applied: acceptedApplied.length,
    appliedSkipped: acceptedSkipped.length,
    proposals: proposalsCreated.length,
    autonomous: result.appliedSummaries.length,
    anomalies: result.anomalies.length,
  })

  return NextResponse.json({
    ok: true,
    status: result.status,
    applied: acceptedApplied.length,
    proposals: proposalsCreated.length,
    // Счётчики памяти-опыта — аддитивно, существующие поля не меняем.
    ...(result.memory ? { memory: result.memory } : {}),
  })
}

export const GET = withCronHeartbeat(JOB_LABEL, handler)
