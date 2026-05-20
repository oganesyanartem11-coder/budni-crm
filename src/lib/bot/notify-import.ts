import { prisma } from '@/lib/db/prisma'
import { sendTelegramMessage } from '@/lib/telegram/send'
import { importButton } from '@/lib/telegram/buttons'
import { escapeHtml } from '@/lib/telegram/notify'

/**
 * Push всем активным ADMIN'ам с привязанным telegramChatId о том, что
 * шеф отправил AI-импорт меню на согласование (8.7). Failure в Telegram
 * не должен ломать server action — оборачиваем всё в try/catch.
 */
export async function notifyAdminsAboutPendingMenuImport(params: {
  menuImportId: string
  dishesCount: number
  chefName: string
}): Promise<void> {
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN', isActive: true, telegramChatId: { not: null } },
      select: { telegramChatId: true },
    })
    if (admins.length === 0) return

    const text =
      `📥 Импорт меню (${params.dishesCount} блюд) отправлен на согласование.\n` +
      `Шеф: ${escapeHtml(params.chefName)}`
    const replyMarkup = importButton(params.menuImportId)

    await Promise.allSettled(
      admins.map((admin) =>
        sendTelegramMessage(admin.telegramChatId!, text, {
          parseMode: 'HTML',
          replyMarkup,
        })
      )
    )
  } catch (err) {
    console.error('[notify-import] notifyAdminsAboutPendingMenuImport failed', err)
  }
}

/**
 * Push шефу-автору импорта о возврате на доработку. Если chefId известен —
 * шлём только ему (адресный); иначе fallback на всех активных CHEF'ов.
 * MenuImport имеет поле createdById, поэтому в норме chefId всегда есть.
 */
export async function notifyChefAboutRejectedMenuImport(params: {
  menuImportId: string
  chefId: string | null
  comment: string
}): Promise<void> {
  try {
    const chefs = await prisma.user.findMany({
      where: {
        ...(params.chefId ? { id: params.chefId } : { role: 'CHEF' }),
        isActive: true,
        telegramChatId: { not: null },
      },
      select: { telegramChatId: true },
    })
    if (chefs.length === 0) return

    const text =
      `↩️ Ваш импорт меню возвращён на доработку.\n\n` +
      `<i>${escapeHtml(params.comment)}</i>`
    const replyMarkup = importButton(params.menuImportId)

    await Promise.allSettled(
      chefs.map((chef) =>
        sendTelegramMessage(chef.telegramChatId!, text, {
          parseMode: 'HTML',
          replyMarkup,
        })
      )
    )
  } catch (err) {
    console.error('[notify-import] notifyChefAboutRejectedMenuImport failed', err)
  }
}
