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
import { sendTelegramMessage, splitForTelegram, type SendTelegramMessageResult } from '@/lib/telegram/send'
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
import { explainPhrase } from './explain'
import { answerDirectFreeText } from './chat-reply'
import {
  parseDealCommand,
  findLeadMatches,
  findRecentLeadCandidates,
  markDealWon,
  cancelDeal,
  type DealLeadCandidate,
} from './deals'
import { handleCallCommand } from './calls'

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

/**
 * Отправка длинного текста в чат Директа с разбивкой на части ≤ 4096 (лимит Telegram)
 * по границам строк — смысл НЕ режем (в отличие от старой обрезки «…»). Части шлём по
 * порядку; возвращаем первый сбой либо { ok:true }. Для сообщений аналитика (полная
 * каузальная цепочка + проверка + предложение), которые могут перерасти один месседж.
 */
export async function sendToDirectChatChunked(text: string): Promise<SendTelegramMessageResult> {
  let firstError: SendTelegramMessageResult | null = null
  for (const part of splitForTelegram(text)) {
    const res = await sendToDirectChat(part)
    if (!res.ok && firstError === null) firstError = res
  }
  return firstError ?? { ok: true }
}

/** Короткое описание лида для подтверждения (без утечки полного телефона). */
function formatLeadShort(lead: DealLeadCandidate): string {
  const digits = (lead.phoneDigits ?? '').replace(/\D/g, '')
  const last4 = digits.length >= 4 ? `…${digits.slice(-4)}` : digits || '—'
  const name = lead.name?.trim() || 'без имени'
  const day = new Date(lead.createdAt.getTime() + 3 * 3600_000).toISOString().slice(0, 10)
  const term = lead.utmTerm?.trim() ? `, фраза «${lead.utmTerm.trim()}»` : ''
  return `${name} (тел. ${last4}, заявка ${day}${term})`
}

/**
 * М5: команда «Борис, сделка <телефон> <сумма>» / «... отмена». Находит лид,
 * ставит dealStatus/dealAmount, отвечает подтверждением. Неоднозначно →
 * перечисляет кандидатов; не найден → честно говорит. Пишет ТОЛЬКО в нашу БД
 * (LandingLead), не в кабинет Директа.
 */
async function handleDealCommand(command: string): Promise<string> {
  const parsed = parseDealCommand(command)
  if (parsed.kind === 'invalid') {
    return (
      `Не понял команду сделки: ${parsed.error}\n` +
      `Пример: <code>Борис, сделка 79991234567 150000</code> (или последние 4 цифры телефона), ` +
      `отмена: <code>Борис, сделка 79991234567 отмена</code>`
    )
  }

  const candidates = await findRecentLeadCandidates(parsed.identifierDigits)
  const matches = findLeadMatches(parsed.identifierDigits, candidates)

  if (matches.length === 0) {
    return 'Не нашёл заявку по этому телефону за последние полгода. Проверь номер (можно последние 4 цифры).'
  }
  if (matches.length > 1) {
    const list = matches.slice(0, 8).map((m) => `— ${formatLeadShort(m)}`).join('\n')
    return (
      `Нашёл несколько заявок с таким телефоном — уточни ПОЛНЫЙ номер, чтобы не ошибиться:\n${list}`
    )
  }

  const lead = matches[0]
  if (parsed.kind === 'cancel') {
    await cancelDeal(lead.id)
    return `Снял отметку сделки: ${formatLeadShort(lead)}.`
  }
  await markDealWon(lead.id, parsed.amountRub!)
  return `Записал сделку: ${formatLeadShort(lead)} — сумма ${Math.round(parsed.amountRub!)} ₽. Учту в недельной «Выручке».`
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

  // ───────────────────────────────────────────────────────────────────────────
  // РОЛЬ «ВЕДЕНИЕ ДИРЕКТА» ОТКЛЮЧЕНА НАСОВСЕМ (решение владельца): кампания
  // переведена на автостратегию Яндекса, Борис Директ больше не ведёт. Любая
  // обращённая команда в чате Директа получает ранний выход — ДО смены режима
  // (боевой/наблюдение), отката, приёма звонков/сделок и любого обращения к
  // Direct API. Личность Бориса и другие роли не затронуты: гейт стоит уже после
  // isDirectChat() + префикса «борис». Логика команд ниже сохранена намеренно
  // (снятие роли с расписания, не снос кода) и сейчас недостижима.
  await ctx.reply(
    'Ведение Директа отключено: кампания переведена на автостратегию Яндекса. ' +
      'Я больше не веду Директ — не меняю ставки и минусы, не рассуждаю и не шлю отчёты.',
    { parse_mode: 'HTML' }
  )
  return

  // «борис, стоп» → «стоп»: убираем префикс и запятые, схлопываем пробелы.
  // (prefix! — на живом пути сужен `if (!prefix) return next()`; блок недостижим
  //  из-за раннего выхода роли, ассерт лишь удерживает типы зелёными.)
  const command = normalized
    .slice(prefix!.length)
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // «Борис, почему <фраза>» — прозрачность решений (ШАГ 1). ТОЛЬКО ЧТЕНИЕ, не
  // команда состояния; отвечаем сразу. Пустая («борис почему») → switch → next().
  if (command.startsWith('почему ')) {
    let explanation: string
    try {
      explanation = await explainPhrase(command.slice('почему '.length).trim())
    } catch (err) {
      console.error('[boris-direct/telegram] команда «почему» упала', err)
      explanation = 'Не получилось объяснить, смотри логи'
    }
    await ctx.reply(explanation, { parse_mode: 'HTML' })
    return
  }

  // Спринт 16.07: «Борис, звонок <телефон> [время] [коммент]» — ручной приём звонка как
  // лида (formType='phone_call', источник null) + подсказка «с какого запроса» по времени
  // (Метрика, гипотеза). Пишем LandingLead, штатную пересылку заявки НЕ триггерим.
  if (command === 'звонок' || command.startsWith('звонок ')) {
    let reply: string
    try {
      reply = await handleCallCommand(command)
    } catch (err) {
      console.error('[boris-direct/telegram] команда «звонок» упала', err)
      reply = 'Не получилось записать звонок, смотри логи'
    }
    await ctx.reply(reply, { parse_mode: 'HTML' })
    return
  }

  // М5: «Борис, сделка <телефон> <сумма>» / «... отмена» — отметка выручки
  // (пишем dealStatus/dealAmount лида, не в кабинет). Аргументная команда до switch.
  if (command === 'сделка' || command.startsWith('сделка ')) {
    let reply: string
    try {
      reply = await handleDealCommand(command)
    } catch (err) {
      console.error('[boris-direct/telegram] команда «сделка» упала', err)
      reply = 'Не получилось записать сделку, смотри логи'
    }
    await ctx.reply(reply, { parse_mode: 'HTML' })
    return
  }

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
        // Обращённый свободный текст (не жёсткая команда) в чате Директа →
        // READ-ONLY доменный ответ РОЛЬЮ трафика (личность общая, домен по чату).
        // НИКАКИХ действий/write — только текст (см. chat-reply.ts). Раньше здесь
        // был next() → общий контур заказов без домена («это не по моей части»).
        reply = await answerDirectFreeText(raw!)
        break
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
      // РОЛЬ «ВЕДЕНИЕ ДИРЕКТА» ОТКЛЮЧЕНА НАСОВСЕМ: даже случайное нажатие старой
      // кнопки «✅ Да»/«❌ Нет» из истории чата не должно решать/применять
      // предложение. Ранний выход ДО decideProposal и любого обращения к кабинету.
      await ctx.answerCallbackQuery({ text: 'Ведение Директа отключено' })
      try {
        await ctx.editMessageReplyMarkup(undefined)
      } catch (err) {
        console.error('[boris-direct/telegram] editMessageReplyMarkup (роль отключена) failed', err)
      }
      return

      if (action !== 'accept' && action !== 'reject') {
        await ctx.answerCallbackQuery({ text: 'Неизвестное действие' })
        return
      }

      const result = await decideProposal(id, action as 'accept' | 'reject')

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
