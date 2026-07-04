/**
 * Telegram-слой роли «трафик Яндекс.Директа» (Борис-Директ):
 *
 *  1. sendToDirectChat — отправка в чат «Директ от Бориса» (TELEGRAM_DIRECT_CHAT_ID),
 *     мягкая деградация если env не задан (не роняем кроны).
 *  2. handleDirectChatMessage — grammy-мидлвара команд владельца («Борис, стоп» /
 *     «боевой» / «наблюдение» / «откати последнее» / «верни гейт» / «статус» /
 *     «что ты понял»).
 *     Live-режим включается ТОЛЬКО этой явной командой владельца — код сам никогда.
 *     Всё, что не команда роли, уходит в next() — существующее поведение бота
 *     (обычный Борис) не трогаем.
 *  3. callback-handler scope 'bdir' — inline-кнопки «✅ Да»/«❌ Нет» под
 *     предложениями (см. proposals.ts). Регистрация ПРИ ИМПОРТЕ модуля
 *     (side-effect), как у scope 'wsub' — оркестратор импортирует модуль в bot.ts.
 *
 * Тексты — статические строки голосом Бориса, HTML parse mode, без LLM.
 */

import type { Context } from 'grammy'
import type { InlineKeyboard } from 'grammy'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { sendTelegramMessage, type SendTelegramMessageResult } from '@/lib/telegram/send'
import { readDirectChatId } from '@/lib/telegram/env'
import { registerCallbackHandler } from '@/lib/telegram/callback-router'
import {
  getDirectRoleState,
  setDirectMode,
  setDirectFrozen,
  setAutoNegativesEnabled,
} from './state'
import { revertLastAction } from './rollback'
import { decideProposal } from './proposals'
import { getActiveLessonsReport } from './lessons'

// ---------- Отправка в чат Директа ----------

/**
 * Обёртка sendTelegramMessage для чата Директа. readDirectChatId может кинуть
 * (env не задан) — тогда { ok: false, error: 'no_chat_id' } + warn, не падаем.
 */
export async function sendToDirectChat(
  text: string,
  opts?: { replyMarkup?: InlineKeyboard }
): Promise<SendTelegramMessageResult> {
  let chatId: string
  try {
    chatId = readDirectChatId()
  } catch {
    console.warn(
      '[boris-direct/telegram] TELEGRAM_DIRECT_CHAT_ID не задан — сообщение в чат Директа не отправлено'
    )
    return { ok: false, error: 'no_chat_id' }
  }
  return sendTelegramMessage(chatId, text, {
    parseMode: 'HTML',
    replyMarkup: opts?.replyMarkup,
  })
}

/** Это чат Директа? env не задан / chatId нет → false (тихо). */
export function isDirectChat(chatId: string | number | undefined): boolean {
  if (chatId === undefined) return false
  try {
    return String(chatId) === readDirectChatId()
  } catch {
    return false
  }
}

// ---------- Команды владельца ----------

/**
 * Лог переключения в BorisDirectActionLog. mode — текущий ПОСЛЕ смены
 * (читаем состояние заново, чтобы freeze/gate логировались с актуальным режимом).
 */
async function logStateChange(
  action: 'mode.change' | 'freeze.change' | 'gate.change',
  after: Prisma.InputJsonValue
): Promise<void> {
  const state = await getDirectRoleState()
  await prisma.borisDirectActionLog.create({
    data: {
      action,
      targetType: 'campaign',
      after,
      reason: 'команда владельца в чате Директа',
      mode: state.mode,
      applied: true,
    },
  })
}

function formatStatus(state: {
  mode: string
  frozen: boolean
  autoNegativesEnabled: boolean
}): string {
  const modeLine =
    state.mode === 'LIVE'
      ? 'боевой (LIVE) — операции реально применяются'
      : 'наблюдение (OBSERVE) — в Директ ничего не пишу'
  const frozenLine = state.frozen
    ? 'включён — вся автономия заморожена'
    : 'снят'
  const gateLine = state.autoNegativesEnabled
    ? 'снят — спорные минусы беру в автономию'
    : 'стоит — спорные минусы иду к тебе предложениями'
  return (
    `<b>Директ — статус роли</b>\n` +
    `Режим: ${modeLine}\n` +
    `Стоп-кран: ${frozenLine}\n` +
    `Гейт спорных минусов: ${gateLine}`
  )
}

/**
 * grammy-мидлвара для bot.on('message', ...). Не чат Директа или текст не
 * начинается с «борис»/«боря» → next() (существующее поведение не трогаем).
 * Неизвестная команда после «борис» → тоже next() (ответит обычный Борис).
 */
export async function handleDirectChatMessage(
  ctx: Context,
  next: () => Promise<void>
): Promise<void> {
  if (!isDirectChat(ctx.chat?.id)) return next()

  const raw = ctx.message?.text
  if (typeof raw !== 'string') return next()

  const normalized = raw.trim().toLowerCase()
  const prefix = ['борис', 'боря'].find((p) => normalized.startsWith(p))
  if (!prefix) return next()

  // «борис, стоп» → «стоп»: убираем префикс и запятые, схлопываем пробелы.
  const command = normalized
    .slice(prefix.length)
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  let reply: string
  try {
    switch (command) {
      case 'стоп':
        await setDirectFrozen(true)
        await logStateChange('freeze.change', { frozen: true })
        reply =
          'Стоп-кран включён. Вся автономия по Директу заморожена до команды "Борис, продолжай".'
        break
      case 'продолжай':
        await setDirectFrozen(false)
        await logStateChange('freeze.change', { frozen: false })
        reply = 'Стоп-кран снят, работаю дальше по текущему режиму.'
        break
      case 'боевой':
        await setDirectMode('LIVE')
        await logStateChange('mode.change', { mode: 'LIVE' })
        reply =
          'Режим боевой. Внимание: автономные операции теперь реально применяются к Директу — ставки и минусы уходят в кампанию. Стоп-кран на всякий случай: "Борис, стоп".'
        break
      case 'наблюдение':
        await setDirectMode('OBSERVE')
        await logStateChange('mode.change', { mode: 'OBSERVE' })
        reply = 'Режим наблюдение. В Директ ничего не пишу — считаю, докладываю, предлагаю.'
        break
      case 'откати последнее': {
        const result = await revertLastAction()
        reply = result.message
        break
      }
      case 'верни гейт':
        await setAutoNegativesEnabled(false)
        await logStateChange('gate.change', { autoNegativesEnabled: false })
        reply = 'Гейт спорных минусов снова на месте — иду с ними к тебе предложениями.'
        break
      case 'статус': {
        const state = await getDirectRoleState()
        reply = formatStatus(state)
        break
      }
      case 'что ты понял':
      case 'что понял':
      case 'чему научился':
        reply = await getActiveLessonsReport()
        break
      default:
        // Не команда роли — пусть отвечает обычный Борис.
        return next()
    }
  } catch (err) {
    console.error(`[boris-direct/telegram] команда владельца «${command}» упала`, err)
    reply = 'Не получилось применить команду, смотри логи'
  }

  await ctx.reply(reply, { parse_mode: 'HTML' })
}

// ---------- Inline-кнопки предложений (scope 'bdir') ----------

/**
 * Регистрирует обработчик колбэков scope 'bdir' (кнопки «✅ Да»/«❌ Нет»).
 * Вызывается при импорте модуля (side-effect ниже); callback-router при
 * повторной регистрации просто переопределяет scope — двойной обработки нет.
 */
export function registerDirectCallbackHandler(): void {
  registerCallbackHandler({
    scope: 'bdir',
    async handle(ctx, action, id) {
      if (action !== 'accept' && action !== 'reject') {
        await ctx.answerCallbackQuery({ text: 'Неизвестное действие' })
        return
      }

      const result = await decideProposal(id, action)

      await ctx.answerCallbackQuery({
        text: result.ok
          ? action === 'accept'
            ? 'Принято'
            : 'Отклонено'
          : 'Уже решено',
      })

      if (!result.ok) return

      // Убираем кнопки под решённым предложением; сообщение могло устареть — не падаем.
      try {
        await ctx.editMessageReplyMarkup(undefined)
      } catch (err) {
        console.error('[boris-direct/telegram] editMessageReplyMarkup failed', err)
      }

      await ctx.reply(result.summaryText, { parse_mode: 'HTML' })
    },
  })
}

registerDirectCallbackHandler()
