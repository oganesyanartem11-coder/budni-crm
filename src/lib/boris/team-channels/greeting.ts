import type { Context } from 'grammy'
import { prisma } from '@/lib/db/prisma'

const GREETING_TEXT = `👋 Команда, привет.

Я Борис — ваш AI-помощник по «Будням». Один член команды в четырёх ипостасях:

- Утренний — Пн-Пт в 08:00 расскажу что нас ждёт сегодня
- Командный — буду делиться рекордами, благодарностями клиентов, тёплым итогом дня и недели. Молчу когда тихо
- Тревожный — если у кого-то из клиентов горит, дам знать
- Личный к Артёму — раз в неделю пишу в личку как у меня получилось

Не справочная — я с вами на работе. Иногда буду молчать, иногда — обнимать команду за хороший день. Главное — делайте своё дело, а я подстрахую.

🔥 Поехали. Неделя в строю.

— Ваш Борис`

const ACTIVITY_ACTION = 'BORIS_GROUP_GREETING_SENT'

/**
 * Обработчик события `my_chat_member`: бот добавлен в группу или его статус
 * изменён. Приветствие отправляется ровно один раз на chatId через защиту
 * по ActivityLog (entityId=chatId).
 *
 * Текст приветствия — captured-string, не LLM. Голос согласован с владельцем.
 *
 * Адресат: ctx.chat.id из самого события (НЕ через notifyGroup —
 * TELEGRAM_GROUP_CHAT_ID до момента переключения указывает на старый чат).
 */
export async function handleMyChatMember(ctx: Context): Promise<void> {
  const update = ctx.myChatMember
  if (!update) return

  const oldStatus = update.old_chat_member.status
  const newStatus = update.new_chat_member.status

  // Реагируем ТОЛЬКО на «бота добавили». Игнорируем promote/restrict/kick.
  const wasOut = oldStatus === 'left' || oldStatus === 'kicked'
  const isIn = newStatus === 'member' || newStatus === 'administrator' || newStatus === 'restricted'
  if (!(wasOut && isIn)) return

  // Группы/супергруппы only — private/channel пропускаем.
  const chatType = update.chat.type
  if (chatType !== 'group' && chatType !== 'supergroup') return

  const chatId = String(update.chat.id)
  const chatTitle = 'title' in update.chat ? update.chat.title ?? '(без названия)' : '(без названия)'

  // Idempotency: уже здоровались в этот чат?
  const already = await prisma.activityLog.findFirst({
    where: { action: ACTIVITY_ACTION, entityId: chatId },
    select: { id: true },
  })
  if (already) {
    console.log(`[boris-greeting] skip: уже здоровались в chatId=${chatId}`)
    return
  }

  // Шлём приветствие в чат события — НЕ через notifyGroup.
  try {
    await ctx.api.sendMessage(update.chat.id, GREETING_TEXT)
  } catch (err) {
    // Молча: 403/400 (нет прав писать) — стандартное поведение notifyGroup.
    console.error(`[boris-greeting] sendMessage failed chatId=${chatId}:`, err)
    return
  }

  // Записываем факт. Логирование chatId+title — чтобы Артём увидел его в БД
  // и скопировал в Vercel ENV TELEGRAM_GROUP_CHAT_ID.
  try {
    await prisma.activityLog.create({
      data: {
        action: ACTIVITY_ACTION,
        entityType: 'TelegramChat',
        entityId: chatId,
        payload: { chatId, chatType, chatTitle, oldStatus, newStatus },
      },
    })
    console.log(`[boris-greeting] ✅ приветствие отправлено в "${chatTitle}" chatId=${chatId}`)
  } catch (err) {
    console.error(`[boris-greeting] ActivityLog write failed:`, err)
  }
}
