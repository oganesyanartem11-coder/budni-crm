import { prisma } from '@/lib/db/prisma'
import { sendTelegramMessage } from '@/lib/telegram/send'
import { menuButton } from '@/lib/telegram/buttons'
import { escapeHtml } from '@/lib/telegram/notify'
import { getTelegramEnv } from '@/lib/telegram/env'

/**
 * Push всем активным ADMIN'ам с привязанным telegramChatId о том, что
 * шеф отправил меню на согласование. Failure в Telegram не должен ломать
 * server action — оборачиваем всё в try/catch и логируем.
 */
export async function notifyAdminsAboutPendingMenu(params: {
  menuCycleId: string
  menuName: string
  chefName: string
}): Promise<void> {
  try {
    const admins = await prisma.user.findMany({
      where: {
        role: 'ADMIN',
        isActive: true,
        telegramChatId: { not: null },
      },
      select: { id: true, telegramChatId: true },
    })

    if (admins.length === 0) return

    const text =
      `🍽 Меню <b>${escapeHtml(params.menuName)}</b> отправлено на согласование.\n` +
      `Шеф: ${escapeHtml(params.chefName)}`
    const replyMarkup = menuButton(params.menuCycleId)

    await Promise.allSettled(
      admins.map((admin) =>
        sendTelegramMessage(admin.telegramChatId!, text, {
          parseMode: 'HTML',
          replyMarkup,
        })
      )
    )
  } catch (err) {
    console.error('[notify-menu] notifyAdminsAboutPendingMenu failed', err)
  }
}

/**
 * Push в групповой чат менеджеров об утверждении меню.
 * Если TELEGRAM_GROUP_CHAT_ID не настроен — тихо пропускаем.
 */
export async function notifyGroupAboutApprovedMenu(params: {
  menuCycleId: string
  menuName: string
}): Promise<void> {
  try {
    const { groupChatId } = getTelegramEnv()
    if (!groupChatId) return

    const text = `✅ Меню <b>${escapeHtml(params.menuName)}</b> утверждено.`
    const replyMarkup = menuButton(params.menuCycleId, '📋 Открыть меню')

    await sendTelegramMessage(groupChatId, text, {
      parseMode: 'HTML',
      replyMarkup,
    })
  } catch (err) {
    console.error('[notify-menu] notifyGroupAboutApprovedMenu failed', err)
  }
}

/**
 * Push всем активным CHEF'ам с привязанным telegramChatId о возврате меню
 * на доработку. У MenuCycle нет поля createdById (см. schema.prisma), поэтому
 * автора конкретно определить нельзя — шлём всем шефам с привязкой.
 */
export async function notifyChefsAboutRejectedMenu(params: {
  menuCycleId: string
  menuName: string
  comment: string | null
}): Promise<void> {
  try {
    const chefs = await prisma.user.findMany({
      where: {
        role: 'CHEF',
        isActive: true,
        telegramChatId: { not: null },
      },
      select: { id: true, telegramChatId: true },
    })

    if (chefs.length === 0) return

    let text = `↩️ Меню <b>${escapeHtml(params.menuName)}</b> возвращено на доработку.`
    if (params.comment && params.comment.trim().length > 0) {
      text += `\n\n<i>${escapeHtml(params.comment)}</i>`
    }
    const replyMarkup = menuButton(params.menuCycleId, '📝 Открыть меню')

    await Promise.allSettled(
      chefs.map((chef) =>
        sendTelegramMessage(chef.telegramChatId!, text, {
          parseMode: 'HTML',
          replyMarkup,
        })
      )
    )
  } catch (err) {
    console.error('[notify-menu] notifyChefsAboutRejectedMenu failed', err)
  }
}
