/**
 * Cron-эндпоинт вечернего итога дня в группу (Командный Боря, канал EVENING).
 *
 * Расписание (vercel.json): Пн-Чт 17:00 UTC (20:00 МСК).
 *
 * Логика:
 * 1. Идемпотентность на МСК-сутки через alreadyRanToday/markRanToday.
 * 2. Сбор контекста дня (DayContext).
 * 3. Если день пустой (нет порций и нет событий) — skip.
 * 4. LLM-генерация поста через formatTeamPost('EVENING', context).
 * 5. shouldSend=false (SILENT) → BorisBriefing с пометкой, без отправки в TG.
 * 6. shouldSend=true → отправка в групповой чат + update sentToTg.
 *
 * ?force=true и ?dryRun=true — для ручных запусков и тестов.
 *
 * Спринт 7.16.C, ЭТАП 2.
 */

import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { BorisMetricSource } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { notifyGroup } from '@/lib/telegram/notify'
import { getTelegramEnv } from '@/lib/telegram/env'
import { trackBorisCall } from '@/lib/boris/metrics/track'
import { buildDayContext, formatTeamPost, type TeamPostResult } from '@/lib/boris/team-channels'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_LABEL = 'boris-team-evening-digest'

async function handler(request: Request) {
  const url = new URL(request.url)
  const force = url.searchParams.get('force') === 'true'
  const isDryRun = url.searchParams.get('dryRun') === 'true'
  const now = new Date()

  // 1. Идемпотентность
  if (!force && (await alreadyRanToday(JOB_LABEL, now))) {
    return NextResponse.json({ ok: true, skipped: 'already_ran' })
  }

  // 2. Контекст дня
  const context = await buildDayContext(now)

  // 3. Skip — день пустой (нет порций и нет событий → LLM дёргать смысла нет).
  if (context.today.portionsTotal === 0 && context.events.length === 0) {
    await markRanToday(JOB_LABEL, { skipped: 'empty_day' })
    return NextResponse.json({ ok: true, skipped: 'empty_day' })
  }

  // 4. ENV — групповой чат
  let groupChatId: string
  try {
    groupChatId = getTelegramEnv().groupChatId
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markRanToday(JOB_LABEL, { skipped: 'no_group_chat', error: msg })
    return NextResponse.json({ ok: true, skipped: 'no_group_chat', error: msg })
  }

  // 5. LLM-генерация
  const startedAt = Date.now()
  let result: TeamPostResult
  try {
    result = await formatTeamPost('EVENING', context)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[cron:${JOB_LABEL}] formatTeamPost failed:`, err)
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
    await markRanToday(JOB_LABEL, { skipped: 'llm_error', error: msg })
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
    await markRanToday(JOB_LABEL, { briefingId: briefing.id, action: 'SILENT' })
    return NextResponse.json({ ok: true, briefingId: briefing.id, action: 'SILENT' })
  }

  // 9. dryRun — не шлём в TG, но всё уже записано
  if (isDryRun) {
    await markRanToday(JOB_LABEL, { briefingId: briefing.id, dryRun: true })
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

  await markRanToday(JOB_LABEL, {
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

export const GET = withCronHeartbeat(JOB_LABEL, handler)
