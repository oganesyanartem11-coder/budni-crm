/**
 * Manual-trigger утреннего брифинга Бориса (Спринт 7.16.B).
 *
 * Доступ — только ADMIN_PRO. Не учитывает выходные и idempotency-гард —
 * Артём может проверять брифинг в любой день и сколько угодно раз.
 *
 * По дефолту dryRun=true (в TG ничего не уходит, только сохраняется
 * BorisBriefing с isDryRun=true). Чтобы реально отправить — ?dryRun=false.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { notifyGroup } from '@/lib/telegram/notify'
import { getTelegramEnv } from '@/lib/telegram/env'
import { buildMorningContext, type MorningContext } from '@/lib/boris/morning/context-builder'
import { generateMorningBriefing } from '@/lib/boris/morning/generator'

export const dynamic = 'force-dynamic'

const INPUT_USD_PER_M = 3
const OUTPUT_USD_PER_M = 15

function calcCostUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * INPUT_USD_PER_M + outputTokens * OUTPUT_USD_PER_M) / 1_000_000
}

export async function POST(request: Request) {
  await requireRole(['ADMIN_PRO'])

  const url = new URL(request.url)
  const isDryRun = url.searchParams.get('dryRun') !== 'false' // default true
  // force параметр оставлен для совместимости с cron-эндпоинтом, но в test-роуте
  // нет idempotency-гарда, поэтому всегда «как force=true».
  const _force = url.searchParams.get('force') !== 'false'
  void _force

  const now = new Date()

  const context: MorningContext | null = await buildMorningContext(now)
  if (!context) {
    return NextResponse.json({ ok: true, skipped: 'empty_context' })
  }

  let groupChatId: string
  try {
    groupChatId = getTelegramEnv().groupChatId
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: true, skipped: 'no_group_chat', error: msg })
  }

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
    return NextResponse.json({ ok: false, error: msg })
  }

  const costUsd = calcCostUsd(inputTokens, outputTokens)

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

  let sentToTg = false
  let sendError: string | null = null
  if (!isDryRun) {
    const result = await notifyGroup(content, { parseMode: 'HTML' })
    sentToTg = result.ok
    sendError = result.ok ? null : (result.error ?? null)
    await prisma.borisBriefing.update({
      where: { id: briefing.id },
      data: { sentToTg, errorMessage: sendError },
    })
  }

  const contextSummary = {
    totalPortionsToday: context.day.totalPortionsToday,
    attentionCount: context.attention.length,
    deltaPercent: Math.round(context.day.deltaPercent),
    hasCharge: context.chargeContext?.recommendCharge ?? false,
  }

  return NextResponse.json({
    ok: true,
    briefingId: briefing.id,
    content,
    contextSummary,
    isDryRun,
    sentToTg,
    sendError,
    costUsd,
    inputTokens,
    outputTokens,
  })
}
