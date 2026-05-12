import { Bot } from 'grammy'
import type { CommandContext, Context } from 'grammy'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getTelegramEnv } from './env'

interface TelegramBotCache {
  bot: Bot
  initialized: boolean
}

// Singleton хранится в globalThis, чтобы переживать перезагрузку модулей
// в dev и переиспользоваться между запросами в одном serverless-инстансе.
const globalForBot = globalThis as unknown as {
  telegramBotCache?: TelegramBotCache
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

function registerHandlers(bot: Bot): void {
  bot.command('start', handleStart)
  bot.on('message', handleOtherMessage)
}

/**
 * Singleton-инстанс Telegram-бота с гарантированной инициализацией.
 *
 * grammy в режиме webhook требует bot.init() перед первым handleUpdate
 * (init подгружает getMe — данные о боте, нужны для парсинга команд и id'шек).
 * Без init получаем «Bot not initialized!» при первом апдейте.
 *
 * init() вызывается ровно один раз на инстанс контейнера: первый вызов
 * выставляет initialized=true, повторные сразу возвращают кэш. Хендлеры
 * регистрируются ДО init, как требует grammy.
 *
 * НЕ вызываем bot.start() — это polling, для Next.js serverless не нужен.
 */
export async function getTelegramBot(): Promise<Bot> {
  if (!globalForBot.telegramBotCache) {
    const { botToken } = getTelegramEnv()
    const bot = new Bot(botToken)
    registerHandlers(bot)
    globalForBot.telegramBotCache = { bot, initialized: false }
  }

  const cache = globalForBot.telegramBotCache
  if (!cache.initialized) {
    await cache.bot.init()
    cache.initialized = true
  }
  return cache.bot
}
