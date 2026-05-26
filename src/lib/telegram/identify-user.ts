import type { Context } from 'grammy'
import type { UserRole } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'

/**
 * 7.16.A.1 (блок A3): идентификация менеджера, написавшего в TG-бот.
 *
 * Маппинг telegram user → внутренний User идёт по уникальному полю
 * `telegramChatId` на модели User (ставится во время onboarding'а через
 * telegramOnboardingToken, см. Спринт 5.8+).
 *
 * Это НЕ middleware grammy (.use()) — handlers вызывают функции явно,
 * чтобы решать что делать, когда юзер не найден или ему не положена роль.
 *
 * Кэш не нужен: prisma client поверх connection pool сам справляется,
 * а наличие/роль/isActive могут поменяться в любой момент админом.
 */

export interface IdentifiedUser {
  id: string
  name: string
  role: UserRole
  isActive: boolean
}

/**
 * Поднимаем юзера по ctx.from.id. Возвращаем null если:
 *  - в апдейте нет from (channel post / какой-то edge case)
 *  - в БД нет юзера с таким telegramChatId
 *  - юзер деактивирован (isActive=false)
 *
 * Ничего НЕ отвечает в чат — это задача requireTelegramUser.
 */
export async function identifyTelegramUser(
  ctx: Context
): Promise<IdentifiedUser | null> {
  const chatId = ctx.from?.id?.toString()
  if (!chatId) {
    return null
  }

  const user = await prisma.user.findUnique({
    where: { telegramChatId: chatId },
    select: { id: true, name: true, role: true, isActive: true },
  })

  if (!user) {
    console.log(`[identify-user] не найден chatId=${chatId}`)
    return null
  }

  if (!user.isActive) {
    console.log(`[identify-user] inactive user=${user.id} (${user.name})`)
    return null
  }

  return user
}

/**
 * Идентифицирует юзера и (опционально) проверяет роль. В случае проблем
 * отвечает в чат человекочитаемой ошибкой и возвращает null — handler
 * должен просто `return`, не делая больше ничего.
 */
export async function requireTelegramUser(
  ctx: Context,
  allowedRoles?: UserRole[]
): Promise<IdentifiedUser | null> {
  const user = await identifyTelegramUser(ctx)
  if (!user) {
    await ctx.reply(
      'Не нашёл тебя в системе. Обратись к админу за подключением.'
    )
    return null
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    await ctx.reply(
      `Эта функция доступна только: ${allowedRoles.join(', ')}.`
    )
    console.log(
      `[identify-user] role denied user=${user.id} role=${user.role} allowed=${allowedRoles.join(',')}`
    )
    return null
  }

  return user
}
