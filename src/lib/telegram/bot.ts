import { Bot } from 'grammy'
import type { CommandContext, Context } from 'grammy'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getTelegramEnv } from './env'

declare global {
  // eslint-disable-next-line no-var
  var __telegramBot: Bot | undefined
}

async function handleStart(ctx: CommandContext<Context>): Promise<void> {
  const token = typeof ctx.match === 'string' ? ctx.match.trim() : ''

  if (!token) {
    await ctx.reply(
      'Добро пожаловать. Этот бот — для менеджеров CRM «Будни». ' +
        'Чтобы привязать аккаунт, зайдите в CRM → Настройки → Telegram и сгенерируйте ссылку.'
    )
    return
  }

  const user = await prisma.user.findFirst({
    where: {
      telegramOnboardingToken: token,
      telegramOnboardingExpiresAt: { gt: new Date() },
    },
  })

  if (!user) {
    await ctx.reply(
      'Ссылка недействительна или истекла. Сгенерируйте новую в CRM → Настройки → Telegram.'
    )
    return
  }

  const chatId = ctx.chat?.id
  if (chatId === undefined) {
    console.warn('[telegram] /start without chat id, user.id=', user.id)
    return
  }
  const telegramChatId = String(chatId)
  const telegramUsername = ctx.from?.username ?? null

  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          telegramChatId,
          telegramUsername,
          telegramOnboardingToken: null,
          telegramOnboardingExpiresAt: null,
        },
      }),
      prisma.activityLog.create({
        data: {
          userId: user.id,
          userRole: user.role,
          action: 'TELEGRAM_ONBOARDED',
          entityType: 'User',
          entityId: user.id,
          payload: { chatId: telegramChatId, username: telegramUsername },
        },
      }),
    ])
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      console.error('[telegram] /start: telegramChatId unique conflict', {
        userId: user.id,
        chatId: telegramChatId,
      })
      await ctx.reply(
        'Этот Telegram-аккаунт уже привязан к другому пользователю CRM. Обратитесь к админу.'
      )
      return
    }
    console.error('[telegram] /start: db error', err)
    await ctx.reply(
      'Не удалось привязать аккаунт из-за внутренней ошибки. Попробуйте позже или обратитесь к админу.'
    )
    return
  }

  await ctx.reply(
    `Готово, ${user.name}. Уведомления и сводки теперь будут приходить сюда.`
  )
}

async function handleOtherMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? ''
  // Команды (/что-то ещё) оставляем без ответа — пусть будут «немыми»
  if (text.startsWith('/')) return
  await ctx.reply('Я бот только для отправки уведомлений и сводок. Отвечать пока не умею.')
}

function createBot(): Bot {
  const { botToken } = getTelegramEnv()
  const bot = new Bot(botToken)
  bot.command('start', handleStart)
  bot.on('message', handleOtherMessage)
  return bot
}

/**
 * Singleton-инстанс Telegram-бота. Хранится в globalThis, чтобы переживать
 * перезагрузку модулей в dev и переиспользоваться между запросами в одном
 * serverless-инстансе. В serverless-prod может пересоздаваться на каждом
 * холодном старте — это норма, регистрация хендлеров идемпотентна.
 *
 * НЕ вызываем bot.start() и bot.init() — это режим polling, который для
 * Next.js serverless не нужен и сломает запуск.
 */
export function getTelegramBot(): Bot {
  if (!globalThis.__telegramBot) {
    globalThis.__telegramBot = createBot()
  }
  return globalThis.__telegramBot
}
