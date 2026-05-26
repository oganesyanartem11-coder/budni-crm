/**
 * Cron-эндпоинт еженедельного самоанализа Бориса.
 *
 * Расписание (выставляется в vercel.json отдельным PR): раз в неделю,
 * например Сб 09:00 МСК — сразу после закрытия финансовой недели Сб-Пт.
 *
 * Логика:
 * 1. Идемпотентность на сутки (alreadyRanToday).
 * 2. Находим первого активного ADMIN_PRO с telegramChatId — самоанализ
 *    адресный (не в группу).
 * 3. Строим context за последнюю завершённую финансовую неделю.
 * 4. Если context = null (нет активности) — skip + mark.
 * 5. Single-shot LLM-вызов → текст отчёта.
 * 6. Создаём BorisBriefing запись (sentToTg=false). При dryRun=true — return.
 * 7. Шлём в Telegram, update briefing с sentToTg/errorMessage.
 * 8. markRanToday.
 *
 * Спринт 7.16.B, блок B1.6.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { sendTelegramMessage } from '@/lib/telegram/send'
import {
  buildSelfAnalysisContext,
  getCurrentFinancialWeek,
} from '@/lib/boris/self-analysis/context-builder'
import { generateSelfAnalysis } from '@/lib/boris/self-analysis/generator'
import { trackBorisCall } from '@/lib/boris/metrics/track'
import { BorisMetricSource } from '@prisma/client'
import type { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_LABEL = 'boris-self-analysis'

async function handler(request: Request) {
  const url = new URL(request.url)
  const force = url.searchParams.get('force') === 'true'
  const isDryRun = url.searchParams.get('dryRun') === 'true'

  const now = new Date()

  // 1. Идемпотентность на сутки (защита от Vercel cron retry).
  if (!force && (await alreadyRanToday(JOB_LABEL, now))) {
    return NextResponse.json({ ok: true, skipped: 'already_ran' })
  }

  // 2. Найти первого активного ADMIN_PRO с telegramChatId.
  const user = await prisma.user.findFirst({
    where: {
      role: 'ADMIN_PRO',
      isActive: true,
      telegramChatId: { not: null },
    },
    select: { id: true, telegramChatId: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!user || !user.telegramChatId) {
    await markRanToday(JOB_LABEL, { skipped: 'no_admin_pro' })
    return NextResponse.json({ ok: true, skipped: 'no_admin_pro' })
  }

  // 3. Окно последней завершённой финансовой недели.
  const { weekStart, weekEnd } = await getCurrentFinancialWeek(now)

  // 4. Контекст. Если null — за неделю не было активности.
  const context = await buildSelfAnalysisContext(user.id, weekStart, weekEnd)
  if (context === null) {
    await markRanToday(JOB_LABEL, { skipped: 'empty_week' })
    return NextResponse.json({ ok: true, skipped: 'empty_week' })
  }

  // 5. LLM-вызов. Оборачиваем в try/catch чтобы при сбое Anthropic API
  // briefing всё равно создался с errorMessage и cron не упал.
  let content: string | null = null
  let inputTokens = 0
  let outputTokens = 0
  let generationError: string | null = null
  const llmStartedAt = Date.now()
  try {
    const result = await generateSelfAnalysis(context)
    content = result.content
    inputTokens = result.inputTokens
    outputTokens = result.outputTokens
    await trackBorisCall({
      userId: user.id,
      ok: true,
      durationMs: Date.now() - llmStartedAt,
      inputTokens,
      outputTokens,
      source: BorisMetricSource.SELF_ANALYSIS,
    })
  } catch (err) {
    generationError = err instanceof Error ? err.message : String(err)
    console.error(`[cron:${JOB_LABEL}] generateSelfAnalysis failed:`, err)
    await trackBorisCall({
      userId: user.id,
      ok: false,
      errorMessage: generationError,
      durationMs: Date.now() - llmStartedAt,
      source: BorisMetricSource.SELF_ANALYSIS,
    })
  }

  const costUsd =
    Math.round(((inputTokens * 3 + outputTokens * 15) / 1_000_000) * 1_000_000) / 1_000_000

  // 6. Создаём BorisBriefing запись (даже при ошибке генерации — для аудита).
  const briefing = await prisma.borisBriefing.create({
    data: {
      type: 'SELF_ANALYSIS',
      recipientUserId: user.id,
      recipientChatId: user.telegramChatId,
      content: content ?? '',
      contextData: context as unknown as Prisma.InputJsonValue,
      isDryRun,
      inputTokens,
      outputTokens,
      costUsd,
      sentToTg: false,
      errorMessage: generationError,
    },
  })

  if (generationError) {
    await markRanToday(JOB_LABEL, { briefingId: briefing.id, error: generationError })
    return NextResponse.json({
      ok: false,
      briefingId: briefing.id,
      error: generationError,
    })
  }

  if (isDryRun) {
    await markRanToday(JOB_LABEL, { briefingId: briefing.id, dryRun: true })
    return NextResponse.json({ ok: true, dryRun: true, briefingId: briefing.id })
  }

  // 7. Шлём в Telegram. sendTelegramMessage не throws — возвращает ok/error.
  let sendError: string | null = null
  let sentToTg = false
  try {
    const sendResult = await sendTelegramMessage(user.telegramChatId, content ?? '', {
      parseMode: 'HTML',
    })
    sentToTg = sendResult.ok
    if (!sendResult.ok) sendError = sendResult.error
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err)
    console.error(`[cron:${JOB_LABEL}] sendTelegramMessage threw:`, err)
  }

  await prisma.borisBriefing.update({
    where: { id: briefing.id },
    data: { sentToTg, errorMessage: sendError },
  })

  // 8. Mark + return.
  await markRanToday(JOB_LABEL, { briefingId: briefing.id, sentToTg })
  return NextResponse.json({
    ok: true,
    briefingId: briefing.id,
    sentToTg,
    error: sendError,
  })
}

export const GET = withCronHeartbeat(JOB_LABEL, handler)
