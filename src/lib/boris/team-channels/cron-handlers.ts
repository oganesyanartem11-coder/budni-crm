/**
 * Inner-handler'ы для cron'ов вечернего итога дня (EVENING) и пятничного
 * недельного итога (FRIDAY). Вынесены из route.ts в отдельный модуль чтобы:
 *
 * 1) cron-route.ts мог обернуть их withCronHeartbeat (auth по CRON_SECRET);
 * 2) server actions из /boris (manual-trigger) могли вызвать ту же логику
 *    напрямую в одном процессе, без HTTP-кругобежки и без CRON_SECRET. Auth
 *    в action'е — через requireRole(['ADMIN_PRO']).
 *
 * До 7.16.C.1 manual-trigger делал fetch(`${baseUrl}/api/cron/...`, {
 *   headers: { authorization: `Bearer ${CRON_SECRET}` }
 * }) и стабильно ловил 401 на Vercel. Эти inner-handler'ы устраняют HTTP-hop.
 *
 * Handler читает только request.url (parsing query: force, dryRun) — никаких
 * headers/cookies/auth не использует, любой Request годится.
 */

import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { BorisMetricSource } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { notifyGroup } from '@/lib/telegram/notify'
import { getTelegramEnv } from '@/lib/telegram/env'
import { trackBorisCall } from '@/lib/boris/metrics/track'
import {
  buildDayContext,
  buildWeekContext,
  formatTeamPost,
  type TeamPostResult,
} from '@/lib/boris/team-channels'

export const EVENING_JOB_LABEL = 'boris-team-evening-digest'
export const FRIDAY_JOB_LABEL = 'boris-team-friday'

// ============================================================
// EVENING — Пн-Чт 17:00 UTC (20:00 МСК)
// ============================================================

export async function runTeamEveningDigest(request: Request): Promise<NextResponse> {
  const url = new URL(request.url)
  const force = url.searchParams.get('force') === 'true'
  const isDryRun = url.searchParams.get('dryRun') === 'true'
  const now = new Date()

  // 1. Идемпотентность
  if (!force && (await alreadyRanToday(EVENING_JOB_LABEL, now))) {
    return NextResponse.json({ ok: true, skipped: 'already_ran' })
  }

  // 2. Контекст дня
  const context = await buildDayContext(now)

  // 3. Skip — день пустой (нет порций и нет событий → LLM дёргать смысла нет).
  if (context.today.portionsTotal === 0 && context.events.length === 0) {
    await markRanToday(EVENING_JOB_LABEL, { skipped: 'empty_day' })
    return NextResponse.json({ ok: true, skipped: 'empty_day' })
  }

  // 4. ENV — групповой чат
  let groupChatId: string
  try {
    groupChatId = getTelegramEnv().groupChatId
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markRanToday(EVENING_JOB_LABEL, { skipped: 'no_group_chat', error: msg })
    return NextResponse.json({ ok: true, skipped: 'no_group_chat', error: msg })
  }

  // 5. LLM-генерация
  const startedAt = Date.now()
  let result: TeamPostResult
  try {
    result = await formatTeamPost('EVENING', context)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[cron:${EVENING_JOB_LABEL}] formatTeamPost failed:`, err)
    await prisma.borisBriefing.create({
      data: {
        type: 'TEAM_EVENING',
        recipientUserId: null,
        recipientChatId: groupChatId,
        content: '',
        contextData: { context } as unknown as Prisma.InputJsonValue,
        isDryRun,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        sentToTg: false,
        errorMessage: msg,
      },
    })
    await trackBorisCall({
      ok: false,
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
      source: BorisMetricSource.TEAM_EVENING,
    })
    await markRanToday(EVENING_JOB_LABEL, { skipped: 'llm_error', error: msg })
    return NextResponse.json({ ok: false, skipped: 'llm_error', error: msg })
  }

  // 6. BorisBriefing запись (sentToTg=false до фактической отправки)
  const briefing = await prisma.borisBriefing.create({
    data: {
      type: 'TEAM_EVENING',
      recipientUserId: null,
      recipientChatId: groupChatId,
      content: result.text ?? '',
      contextData: {
        context,
        briefingPayload: result.briefingPayload,
      } as unknown as Prisma.InputJsonValue,
      isDryRun,
      inputTokens: result.metrics.inputTokens,
      outputTokens: result.metrics.outputTokens,
      costUsd: result.metrics.costUsd,
      sentToTg: false,
    },
  })

  // 7. Метрики LLM-вызова
  await trackBorisCall({
    ok: true,
    durationMs: Date.now() - startedAt,
    inputTokens: result.metrics.inputTokens,
    outputTokens: result.metrics.outputTokens,
    cacheCreationInputTokens: result.metrics.cacheCreationInputTokens,
    cacheReadInputTokens: result.metrics.cacheReadInputTokens,
    source: BorisMetricSource.TEAM_EVENING,
  })

  // 8. SILENT — Боря решил молчать. БД сохранили, в TG не пишем.
  if (!result.shouldSend) {
    await markRanToday(EVENING_JOB_LABEL, { briefingId: briefing.id, action: 'SILENT' })
    return NextResponse.json({ ok: true, briefingId: briefing.id, action: 'SILENT' })
  }

  // 9. dryRun — не шлём в TG, но всё уже записано
  if (isDryRun) {
    await markRanToday(EVENING_JOB_LABEL, { briefingId: briefing.id, dryRun: true })
    return NextResponse.json({ ok: true, dryRun: true, briefingId: briefing.id })
  }

  // 10. Отправка в групповой чат
  const sendResult = await notifyGroup(result.text!, { parseMode: 'HTML' })

  await prisma.borisBriefing.update({
    where: { id: briefing.id },
    data: {
      sentToTg: sendResult.ok,
      errorMessage: sendResult.ok ? null : (sendResult.error ?? null),
    },
  })

  await markRanToday(EVENING_JOB_LABEL, {
    briefingId: briefing.id,
    sentToTg: sendResult.ok,
    action: 'SEND',
  })

  return NextResponse.json({
    ok: true,
    briefingId: briefing.id,
    sentToTg: sendResult.ok,
    action: 'SEND',
  })
}

// ============================================================
// FRIDAY — Пт 16:00 UTC (19:00 МСК)
// ============================================================

export async function runTeamFridayDigest(request: Request): Promise<NextResponse> {
  const url = new URL(request.url)
  const force = url.searchParams.get('force') === 'true'
  const isDryRun = url.searchParams.get('dryRun') === 'true'
  const now = new Date()

  // 1. Идемпотентность
  if (!force && (await alreadyRanToday(FRIDAY_JOB_LABEL, now))) {
    return NextResponse.json({ ok: true, skipped: 'already_ran' })
  }

  // 2. Контекст недели
  const context = await buildWeekContext(now)

  // 3. Skip — за неделю не было активности
  if (context.portionsTotal === 0) {
    await markRanToday(FRIDAY_JOB_LABEL, { skipped: 'empty_week' })
    return NextResponse.json({ ok: true, skipped: 'empty_week' })
  }

  // 4. ENV — групповой чат
  let groupChatId: string
  try {
    groupChatId = getTelegramEnv().groupChatId
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markRanToday(FRIDAY_JOB_LABEL, { skipped: 'no_group_chat', error: msg })
    return NextResponse.json({ ok: true, skipped: 'no_group_chat', error: msg })
  }

  // 5. LLM-генерация
  const startedAt = Date.now()
  let result: TeamPostResult
  try {
    result = await formatTeamPost('FRIDAY', context)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[cron:${FRIDAY_JOB_LABEL}] formatTeamPost failed:`, err)
    await prisma.borisBriefing.create({
      data: {
        type: 'TEAM_FRIDAY',
        recipientUserId: null,
        recipientChatId: groupChatId,
        content: '',
        contextData: { context } as unknown as Prisma.InputJsonValue,
        isDryRun,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        sentToTg: false,
        errorMessage: msg,
      },
    })
    await trackBorisCall({
      ok: false,
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
      source: BorisMetricSource.TEAM_FRIDAY,
    })
    await markRanToday(FRIDAY_JOB_LABEL, { skipped: 'llm_error', error: msg })
    return NextResponse.json({ ok: false, skipped: 'llm_error', error: msg })
  }

  // 6. Защита: для FRIDAY ожидается shouldSend=true. Если AI всё-таки вернул
  // SILENT — это инцидент, логируем в errorMessage и НЕ отправляем.
  const unexpectedSilent = !result.shouldSend

  const briefing = await prisma.borisBriefing.create({
    data: {
      type: 'TEAM_FRIDAY',
      recipientUserId: null,
      recipientChatId: groupChatId,
      content: result.text ?? '',
      contextData: {
        context,
        briefingPayload: result.briefingPayload,
      } as unknown as Prisma.InputJsonValue,
      isDryRun,
      inputTokens: result.metrics.inputTokens,
      outputTokens: result.metrics.outputTokens,
      costUsd: result.metrics.costUsd,
      sentToTg: false,
      errorMessage: unexpectedSilent ? 'unexpected_silent_for_friday' : null,
    },
  })

  // 7. Метрики LLM-вызова
  await trackBorisCall({
    ok: true,
    durationMs: Date.now() - startedAt,
    inputTokens: result.metrics.inputTokens,
    outputTokens: result.metrics.outputTokens,
    cacheCreationInputTokens: result.metrics.cacheCreationInputTokens,
    cacheReadInputTokens: result.metrics.cacheReadInputTokens,
    source: BorisMetricSource.TEAM_FRIDAY,
  })

  // 8. Аномальный SILENT — не отправляем в TG
  if (unexpectedSilent) {
    await markRanToday(FRIDAY_JOB_LABEL, {
      briefingId: briefing.id,
      action: 'SILENT',
      error: 'unexpected_silent_for_friday',
    })
    return NextResponse.json({
      ok: false,
      briefingId: briefing.id,
      action: 'SILENT',
      error: 'unexpected_silent_for_friday',
    })
  }

  // 9. dryRun
  if (isDryRun) {
    await markRanToday(FRIDAY_JOB_LABEL, { briefingId: briefing.id, dryRun: true })
    return NextResponse.json({ ok: true, dryRun: true, briefingId: briefing.id })
  }

  // 10. Отправка в групповой чат
  const sendResult = await notifyGroup(result.text!, { parseMode: 'HTML' })

  await prisma.borisBriefing.update({
    where: { id: briefing.id },
    data: {
      sentToTg: sendResult.ok,
      errorMessage: sendResult.ok ? null : (sendResult.error ?? null),
    },
  })

  await markRanToday(FRIDAY_JOB_LABEL, {
    briefingId: briefing.id,
    sentToTg: sendResult.ok,
    action: 'SEND',
  })

  return NextResponse.json({
    ok: true,
    briefingId: briefing.id,
    sentToTg: sendResult.ok,
    action: 'SEND',
  })
}
