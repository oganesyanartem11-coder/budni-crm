/**
 * scripts/test-boris-locally.ts
 *
 * Запуск: `npx tsx scripts/test-boris-locally.ts`
 *
 * НЕ ЗАПУСКАЕТСЯ ИЗ subagent — главный агент может запустить вручную для проверки.
 * Цель: smoke-test что chatWithBoris вообще не падает + показать preview formatting.
 *
 * Sprint 7.16.A.2, блок B4.2 (untracked — не для CI).
 */
import { chatWithBoris } from '@/lib/boris/agent'
import { buildMultiActionPreview } from '@/lib/boris/preview'
import { prisma } from '@/lib/db/prisma'

async function main() {
  // 1. Найти любого ADMIN/MANAGER юзера для теста.
  const user = await prisma.user.findFirst({
    where: { role: { in: ['ADMIN', 'ADMIN_PRO', 'MANAGER'] } },
  })
  if (!user) {
    console.log('Нет тест-юзера в БД (ADMIN / ADMIN_PRO / MANAGER)')
    return
  }

  console.log('=== Тест 1: factual query ===')
  const r1 = await chatWithBoris({
    userId: user.id,
    userText: 'привет, что ты умеешь?',
    chatType: 'private',
    // #4: беседа ключуется по userId+chatId; для локального смоука хватает
    // синтетического id (в личке chat.id == from.id, БД-юзер тут тестовый).
    chatId: user.telegramChatId ?? `local-test-${user.id}`,
    userRole: user.role,
  })
  console.log('reply:', r1.reply)
  console.log('conv:', r1.conversationId)

  console.log('\n=== Тест 2: preview formatter (без LLM) ===')
  const preview = buildMultiActionPreview([
    {
      tool: 'edit_order_portions',
      input: { orderId: 'fake123', portions: 388 },
      preview:
        'СИРИУС, среда 27.05\n- Обед: 387 → 388 порций (+1)\n- Точка: Мневники',
    },
  ])
  console.log(preview)

  console.log('\n=== Тест 3: multi-action preview ===')
  const multi = buildMultiActionPreview([
    {
      tool: 'cancel_order',
      input: { orderId: 'a1' },
      preview: 'СИРИУС, среда 27.05, Обед',
    },
    {
      tool: 'create_one_time_order',
      input: {
        clientId: 'c1',
        locationId: 'l1',
        mealType: 'LUNCH',
        deliveryDate: '2026-05-28',
        portions: 100,
      },
      preview: 'СИРИУС, четверг 28.05, Обед, 100 порций',
    },
  ])
  console.log(multi)

  console.log('\n=== Тест 4: edge case — empty actions ===')
  console.log(buildMultiActionPreview([]))

  console.log('\n=== Тест 5: fallback formatter (без action.preview) ===')
  console.log(
    buildMultiActionPreview([
      {
        tool: 'add_order_note',
        input: {
          orderId: 'ord42',
          note: 'Очень длинная заметка которая должна быть обрезана по 60 символов чтобы влезла красиво',
        },
      },
    ]),
  )
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
