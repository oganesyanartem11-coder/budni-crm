/**
 * emit.ts — Командный Борис, ЭТАП 2 (Sprint 7.16.C).
 *
 * Превращает уже записанный BorisEventLog в пост в групповой чат через
 * AI-formatter и единовременно фиксирует следы: BorisBriefing (для UI/дебага),
 * BorisMetrics (для cost-трекинга), BorisEventLog.emittedTo/emittedAt
 * (защита от повторной озвучки того же события).
 *
 * Контракт:
 *   - Никогда не throws — outer try/catch ловит всё, в худшем случае только
 *     console.error. Триггеры зовут через `void emitLivePost(event).catch(...)`,
 *     чтобы не блокировать пользовательский flow (например, ответ боту).
 *   - BorisBriefing создаётся ВСЕГДА — и при SEND, и при SILENT, и при ошибке
 *     LLM. Это гарантирует что /boris UI видит каждое решение «озвучить или нет»,
 *     даже когда AI решил промолчать.
 *   - event.emittedAt выставляется ТОЛЬКО при фактической отправке в TG
 *     (shouldSend=true && notifyGroup.ok=true). SILENT и ошибки оставляют
 *     emittedAt=null — это валидное состояние «событие зафиксировано, но не
 *     озвучено», cron-каналы (EVENING/FRIDAY) их подхватят.
 */

import type { BorisEventLog, Prisma } from '@prisma/client'
import { BorisMetricSource } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { notifyGroup } from '@/lib/telegram/notify'
import { getTelegramEnv } from '@/lib/telegram/env'
import { trackBorisCall } from '@/lib/boris/metrics/track'
import { buildDayContext } from './context-builder'
import { formatTeamPost } from './ai-formatter'
import type { TeamChannel } from './types'

type EmitChannel = Extract<TeamChannel, 'LIVE' | 'ALERT'>

interface EmitChannelConfig {
  briefingType: 'TEAM_LIVE' | 'TEAM_ALERT'
  metricSource: BorisMetricSource
  channelEnum: 'LIVE' | 'ALERT'
}

const CHANNEL_CONFIG: Record<EmitChannel, EmitChannelConfig> = {
  LIVE: {
    briefingType: 'TEAM_LIVE',
    metricSource: BorisMetricSource.TEAM_LIVE,
    channelEnum: 'LIVE',
  },
  ALERT: {
    briefingType: 'TEAM_ALERT',
    metricSource: BorisMetricSource.TEAM_ALERT,
    channelEnum: 'ALERT',
  },
}

async function emitPost(channel: EmitChannel, event: BorisEventLog): Promise<void> {
  const config = CHANNEL_CONFIG[channel]
  const startedAt = Date.now()
  let recipientChatId = ''
  try {
    recipientChatId = getTelegramEnv().groupChatId
  } catch (err) {
    console.error(`[boris-team/emit] cannot read groupChatId for ${channel}:`, err)
  }

  try {
    const day = await buildDayContext(new Date()).catch((err) => {
      console.error(`[boris-team/emit] buildDayContext failed for ${channel}:`, err)
      return undefined
    })

    let formatResult: Awaited<ReturnType<typeof formatTeamPost>> | null = null
    let formatError: string | null = null
    try {
      formatResult = await formatTeamPost(channel, { event, day })
    } catch (err) {
      formatError = err instanceof Error ? err.message : String(err)
      console.error(`[boris-team/emit] formatTeamPost failed for ${channel}:`, err)
    }

    // Ошибка LLM — фиксируем след и выходим. event.emittedAt остаётся null.
    if (!formatResult) {
      await prisma.borisBriefing
        .create({
          data: {
            type: config.briefingType,
            recipientUserId: null,
            recipientChatId,
            content: '',
            contextData: {
              event: event.id,
              eventType: event.eventType,
              decision: 'ERROR',
              error: formatError,
            },
            sentToTg: false,
            errorMessage: formatError,
            isDryRun: false,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
          },
        })
        .catch((err) => {
          console.error(`[boris-team/emit] briefing(ERROR) write failed for ${channel}:`, err)
        })
      await trackBorisCall({
        ok: false,
        errorMessage: formatError ?? 'formatTeamPost returned null',
        durationMs: Date.now() - startedAt,
        source: config.metricSource,
      })
      return
    }

    const { shouldSend, text, briefingPayload, metrics } = formatResult

    // SILENT — Боря решил молчать. Это легитимный исход (особенно для LIVE).
    if (!shouldSend || !text) {
      await prisma.borisBriefing
        .create({
          data: {
            type: config.briefingType,
            recipientUserId: null,
            recipientChatId,
            content: '',
            contextData: {
              event: event.id,
              eventType: event.eventType,
              decision: 'SILENT',
              briefingPayload,
            } as Prisma.InputJsonValue,
            sentToTg: false,
            errorMessage: null,
            isDryRun: false,
            inputTokens: metrics.inputTokens,
            outputTokens: metrics.outputTokens,
            costUsd: metrics.costUsd,
          },
        })
        .catch((err) => {
          console.error(`[boris-team/emit] briefing(SILENT) write failed for ${channel}:`, err)
        })
      await trackBorisCall({
        ok: true,
        durationMs: Date.now() - startedAt,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cacheCreationInputTokens: metrics.cacheCreationInputTokens,
        cacheReadInputTokens: metrics.cacheReadInputTokens,
        source: config.metricSource,
      })
      return
    }

    // SEND — отправляем в групповой чат.
    const sendResult = await notifyGroup(text, { parseMode: 'HTML' })

    await prisma.borisBriefing
      .create({
        data: {
          type: config.briefingType,
          recipientUserId: null,
          recipientChatId,
          content: text,
          contextData: {
            event: event.id,
            eventType: event.eventType,
            decision: 'SEND',
            briefingPayload,
          } as Prisma.InputJsonValue,
          sentToTg: sendResult.ok,
          errorMessage: sendResult.ok ? null : (sendResult.error ?? 'notifyGroup_failed'),
          isDryRun: false,
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          costUsd: metrics.costUsd,
        },
      })
      .catch((err) => {
        console.error(`[boris-team/emit] briefing(SEND) write failed for ${channel}:`, err)
      })

    // Помечаем событие как озвученное только при реально успешной отправке.
    // Если TG упал — событие остаётся «свежим» и cron-каналы потом подберут.
    if (sendResult.ok) {
      await prisma.borisEventLog
        .update({
          where: { id: event.id },
          data: { emittedTo: config.channelEnum, emittedAt: new Date() },
        })
        .catch((err) => {
          console.error(`[boris-team/emit] eventLog update failed for ${channel}:`, err)
        })
    }

    await trackBorisCall({
      ok: true,
      durationMs: Date.now() - startedAt,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cacheCreationInputTokens: metrics.cacheCreationInputTokens,
      cacheReadInputTokens: metrics.cacheReadInputTokens,
      source: config.metricSource,
      errorMessage: sendResult.ok ? undefined : (sendResult.error ?? 'notifyGroup_failed'),
    })
  } catch (err) {
    // Защитный outer-catch: emit зовётся fire-and-forget, поэтому даже
    // непредвиденная ошибка не должна торчать как unhandled rejection.
    console.error(`[boris-team/emit] unexpected error for ${channel}:`, err)
    try {
      await trackBorisCall({
        ok: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
        source: config.metricSource,
      })
    } catch {
      // глотаем — мы уже в обработчике ошибок
    }
  }
}

export async function emitLivePost(event: BorisEventLog): Promise<void> {
  return emitPost('LIVE', event)
}

export async function emitAlertPost(event: BorisEventLog): Promise<void> {
  return emitPost('ALERT', event)
}
