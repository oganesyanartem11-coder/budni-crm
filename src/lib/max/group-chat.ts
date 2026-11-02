import type { Context, FilteredContext } from '@maxhub/max-bot-api'
import { prisma } from '@/lib/db/prisma'
import { MAX_BOT_USERNAME } from '@/lib/bot/onboarding'
import { hasDateHint } from '@/lib/bot/extract-delivery-date'

/** Conservative filter: unrelated numbers (phones, times, conversation) are not orders. */
export function isGroupOrderMessage(text: string, replyToBot: boolean, hasAttachment: boolean, weeklyImage = false): boolean {
  if (replyToBot || new RegExp(`@${MAX_BOT_USERNAME}\\b`, 'i').test(text)) return true
  if (hasAttachment) return weeklyImage || /заявк|заказ|порци|завтрак|обед|ужин/i.test(text)
  const cleaned = text.trim()
  if (/^\d{1,4}\s*(?:порци[яйи]|шт\.?)?[.!]?$/i.test(cleaned)) return true
  if (/^(?:без изменений|как вчера|как обычно|как всегда|то же самое|аналогично|по-прежнему)[.!]?$/i.test(cleaned)) return true
  if (/порци|завтрак|обед|ужин|заявк|заказ/i.test(cleaned)) return true
  if (/(?:добав|убав|увелич|уменьш|давайте)/i.test(cleaned) && /\d/.test(cleaned)) return true
  if (/(?:добав|убер|убрат|отмен|не (?:надо|нужно|нужен|нужны)|уменьш)/i.test(cleaned)) return true
  if (/\d/.test(cleaned) && hasDateHint(cleaned.toLowerCase())) return true
  return /\d/.test(cleaned) && /завтра|сегодня|понедельник|вторник|сред[ау]|четверг|пятниц|суббот|воскресень|стабильно/i.test(cleaned)
}

export async function bindGroup(chatId: string, token: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.clientMaxGroup.findUnique({ where: { token }, include: { client: true } })
    if (!invite || !invite.client.isActive || !invite.expiresAt || invite.expiresAt <= new Date()) {
      return 'Код недействителен или истёк. Получите новый в карточке клиента.'
    }
    const existing = await tx.clientMaxGroup.findUnique({ where: { chatId } })
    if (existing && existing.clientId !== invite.clientId) return 'Группа уже привязана к другому клиенту. Сначала отключите её в CRM.'
    const claim = await tx.clientMaxGroup.updateMany({
      where: { id: invite.id, token, expiresAt: { gt: new Date() } },
      data: { chatId, token: null, expiresAt: null, isActive: true, linkedAt: new Date() },
    })
    if (!claim.count) return 'Код уже использован. Получите новый в карточке клиента.'
    await tx.activityLog.create({ data: {
      action: 'MAX_GROUP_LINKED', entityType: 'Client', entityId: invite.clientId,
      payload: { chatId }, userId: null,
    } })
    return `Группа подключена к клиенту «${invite.client.name}». Вопросы о количестве будут приходить сюда и в личный чат. Ответить может любой участник. Если количество изменилось — напишите новое число.`
  })
}

export async function handleBotAdded(ctx: FilteredContext<Context, 'bot_added'>) {
  if (ctx.update.is_channel) return
  await ctx.reply('Чтобы подключить заказы, получите код в карточке клиента в CRM → MAX → «Подключить группу» и отправьте сюда команду /привязать КОД. Выдайте боту право читать сообщения группы.')
}

export async function handleBotRemoved(ctx: FilteredContext<Context, 'bot_removed'>) {
  await prisma.clientMaxGroup.updateMany({ where: { chatId: String(ctx.chatId) }, data: { isActive: false } })
}
