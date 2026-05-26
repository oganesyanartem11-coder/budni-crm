/**
 * Manual-trigger endpoint самоанализа Бориса (для тестов и принудительного перезапуска).
 *
 * Доступен только ADMIN_PRO (requireRole). НЕ проходит через alreadyRanToday —
 * админ может дёргать сколько угодно раз. По умолчанию dryRun=true: ответ
 * возвращается в JSON, в TG ничего не уходит.
 *
 * POST /api/admin/boris/test-self-analysis?dryRun=true|false
 *
 * Спринт 7.16.B, блок B1.7.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
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

export async function POST(request: Request) {
  // 1. Только ADMIN_PRO. requireRole редиректит на /login или /dashboard
  // если права не подходят — для API-route это пробросит NEXT_REDIRECT.
  await requireRole(['ADMIN_PRO'])

  const url = new URL(request.url)
  // По умолчанию dryRun=true (тестовый прогон), но можно явно false.
  const isDryRun = url.searchParams.get('dryRun') !== 'false'
  // force параметр оставлен для симметрии с cron-эндпоинтом, но в test-роуте
  // нет idempotency-гарда — endpoint всегда выполняется до конца. Читаем
  // явно, чтобы намерение было видно в коде (а не "молча проигнорировано").
  const _force = url.searchParams.get('force') !== 'false'
  void _force

  const now = new Date()

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
    return NextResponse.json({ ok: false, error: 'no_admin_pro_with_telegram' }, { status: 404 })
  }

  const { weekStart, weekEnd } = await getCurrentFinancialWeek(now)
  const context = await buildSelfAnalysisContext(user.id, weekStart, weekEnd)
  if (context === null) {
    return NextResponse.json({ ok: true, skipped: 'empty_week', weekStart, weekEnd })
  }

  // Генерация. На исключении Anthropic API всё равно создаём briefing с errorMessage,
  // чтобы админ видел причину в БД.
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
    console.error('[admin:test-self-analysis] generateSelfAnalysis failed:', err)
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
    return NextResponse.json(
      { ok: false, briefingId: briefing.id, error: generationError },
      { status: 502 }
    )
  }

  if (isDryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      briefingId: briefing.id,
      content,
    })
  }

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
    console.error('[admin:test-self-analysis] sendTelegramMessage threw:', err)
  }

  await prisma.borisBriefing.update({
    where: { id: briefing.id },
    data: { sentToTg, errorMessage: sendError },
  })

  return NextResponse.json({
    ok: true,
    briefingId: briefing.id,
    sentToTg,
    error: sendError,
  })
}
