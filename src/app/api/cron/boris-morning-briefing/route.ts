/**
 * Cron-эндпоинт утреннего брифинга Бориса (Спринт 7.16.B).
 *
 * Расписание (vercel.json): Пн-Пт 5:00 UTC (8:00 МСК).
 *
 * Логика:
 * 1. Скип сб/вс (защита на случай неверного расписания).
 * 2. Идемпотентность на сутки через alreadyRanToday/markRanToday.
 * 3. Сбор контекста → null = empty_context (нет порций сегодня).
 * 4. LLM-генерация → сохранение в BorisBriefing → отправка в TG.
 * 5. ?force=true и ?dryRun=true — для ручных запусков и тестов.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { notifyGroup } from '@/lib/telegram/notify'
import { getTelegramEnv } from '@/lib/telegram/env'
import { buildMorningContext, type MorningContext } from '@/lib/boris/morning/context-builder'
import { generateMorningBriefing } from '@/lib/boris/morning/generator'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_LABEL = 'boris-morning-briefing'

// Sonnet 4.6 тариф: $3/M input, $15/M output.
const INPUT_USD_PER_M = 3
const OUTPUT_USD_PER_M = 15

function calcCostUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * INPUT_USD_PER_M + outputTokens * OUTPUT_USD_PER_M) / 1_000_000
}

/** МСК weekday (1..7, Пн=1, Вс=7). UTC+3 без учёта сезона (Москва без DST). */
function mskWeekday(now: Date): number {
  const mskHourMs = 3 * 3600_000
  const m = new Date(now.getTime() + mskHourMs)
  const d = m.getUTCDay()
  return d === 0 ? 7 : d
}

async function handler(request: Request) {
  const now = new Date()
  const url = new URL(request.url)
  const force = url.searchParams.get('force') === 'true'
  const isDryRun = url.searchParams.get('dryRun') === 'true'

  // 1. Weekend skip
  const wd = mskWeekday(now)
  if (wd === 6 || wd === 7) {
    return NextResponse.json({ ok: true, skipped: 'weekend' })
  }

  // 2. Идемпотентность
  if (!force && (await alreadyRanToday(JOB_LABEL, now))) {
    return NextResponse.json({ ok: true, skipped: 'already_ran' })
  }

  // 3. Контекст
  let context: MorningContext | null
  try {
    context = await buildMorningContext(now)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markRanToday(JOB_LABEL, { skipped: 'context_error', error: msg })
    return NextResponse.json({ ok: false, skipped: 'context_error', error: msg })
  }
  if (!context) {
    await markRanToday(JOB_LABEL, { skipped: 'empty_context' })
    return NextResponse.json({ ok: true, skipped: 'empty_context' })
  }

  // 4. ENV — групповой чат
  let groupChatId: string
  try {
    groupChatId = getTelegramEnv().groupChatId
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Симметрия с empty_context: маркируем чтобы не дёргать LLM повторно
    // в течение суток, если env временно сломан.
    await markRanToday(JOB_LABEL, { skipped: 'no_group_chat', error: msg })
    return NextResponse.json({ ok: true, skipped: 'no_group_chat', error: msg })
  }

  // 5. LLM
  let content: string
  let inputTokens: number
  let outputTokens: number
  try {
    const res = await generateMorningBriefing(context)
    content = res.content
    inputTokens = res.inputTokens
    outputTokens = res.outputTokens
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.borisBriefing.create({
      data: {
        type: 'MORNING',
        recipientUserId: null,
        recipientChatId: groupChatId,
        content: '',
        contextData: context as unknown as object,
        sentToTg: false,
        errorMessage: msg,
        isDryRun,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      },
    })
    await markRanToday(JOB_LABEL, { skipped: 'llm_error', error: msg })
    return NextResponse.json({ ok: false, skipped: 'llm_error', error: msg })
  }

  const costUsd = calcCostUsd(inputTokens, outputTokens)

  // 6. Сохраняем BorisBriefing
  const briefing = await prisma.borisBriefing.create({
    data: {
      type: 'MORNING',
      recipientUserId: null,
      recipientChatId: groupChatId,
      content,
      contextData: context as unknown as object,
      isDryRun,
      inputTokens,
      outputTokens,
      costUsd,
    },
  })

  if (isDryRun) {
    await markRanToday(JOB_LABEL, { briefingId: briefing.id, dryRun: true })
    return NextResponse.json({ ok: true, dryRun: true, briefingId: briefing.id })
  }

  // 7. Отправка в TG
  const result = await notifyGroup(content, { parseMode: 'HTML' })

  await prisma.borisBriefing.update({
    where: { id: briefing.id },
    data: {
      sentToTg: result.ok,
      errorMessage: result.ok ? null : (result.error ?? null),
    },
  })

  await markRanToday(JOB_LABEL, { briefingId: briefing.id, sentToTg: result.ok })

  return NextResponse.json({ ok: true, briefingId: briefing.id, sentToTg: result.ok })
}

export const GET = withCronHeartbeat(JOB_LABEL, handler)
