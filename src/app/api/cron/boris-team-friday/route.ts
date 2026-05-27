/**
 * Cron-эндпоинт пятничного недельного итога в группу (Командный Боря, канал FRIDAY).
 *
 * Расписание (vercel.json): Пт 16:00 UTC (19:00 МСК).
 * Cron срабатывает в пятницу-вечер; buildWeekContext возьмёт текущую финансовую
 * неделю (Сб-Пт), оканчивающуюся сегодня.
 *
 * Логика:
 * 1. Идемпотентность на МСК-сутки через alreadyRanToday/markRanToday.
 * 2. Сбор контекста недели (WeekContext).
 * 3. Если portionsTotal=0 — skip:'empty_week' (не за что отчитываться).
 * 4. LLM-генерация поста через formatTeamPost('FRIDAY', context).
 *    Для FRIDAY personality всегда возвращает SEND. На всякий случай защита от
 *    неожиданного SILENT.
 * 5. Отправка в групповой чат + update sentToTg.
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
import { buildWeekContext, formatTeamPost, type TeamPostResult } from '@/lib/boris/team-channels'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_LABEL = 'boris-team-friday'

async function handler(request: Request) {
  const url = new URL(request.url)
  const force = url.searchParams.get('force') === 'true'
  const isDryRun = url.searchParams.get('dryRun') === 'true'
  const now = new Date()

  // 1. Идемпотентность
  if (!force && (await alreadyRanToday(JOB_LABEL, now))) {
    return NextResponse.json({ ok: true, skipped: 'already_ran' })
  }

  // 2. Контекст недели
  const context = await buildWeekContext(now)

  // 3. Skip — за неделю не было активности
  if (context.portionsTotal === 0) {
    await markRanToday(JOB_LABEL, { skipped: 'empty_week' })
    return NextResponse.json({ ok: true, skipped: 'empty_week' })
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
    result = await formatTeamPost('FRIDAY', context)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[cron:${JOB_LABEL}] formatTeamPost failed:`, err)
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
    await markRanToday(JOB_LABEL, { skipped: 'llm_error', error: msg })
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
    await markRanToday(JOB_LABEL, {
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
