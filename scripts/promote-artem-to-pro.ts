/**
 * 7.14A: одноразовый скрипт — повышает Артёма до ADMIN_PRO.
 *
 * Запускать ВРУЧНУЮ:
 *   npx dotenv -e .env.test -- npx tsx scripts/promote-artem-to-pro.ts
 *   npx dotenv -e .env.local -- npx tsx scripts/promote-artem-to-pro.ts   # prod-ish БД
 *
 * Untracked. Не коммитим — после успешного запуска можно удалить.
 */

import { prisma } from '@/lib/db/prisma'

;(async () => {
  // Строгий matcher: только реальный Артём, без fallback на «первого ADMIN».
  // Match case-insensitive по подстроке «артём» / «artem» в name.
  const NAME_MATCHER = /(артём|artem)/i

  const candidates = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'ADMIN_PRO'] } },
    select: { id: true, name: true, role: true },
  })
  console.log(
    'ADMIN(_PRO) кандидаты в БД:',
    candidates.map((c) => ({ id: c.id, name: c.name, role: c.role })),
  )

  const matched = candidates.filter((c) => NAME_MATCHER.test(c.name))

  if (matched.length === 0) {
    console.error('❌ Артём не найден среди ADMIN/ADMIN_PRO. Промоут не выполнен.')
    process.exit(2)
  }

  if (matched.length > 1) {
    console.error(
      `❌ Найдено ${matched.length} кандидатов на «Артём» — неоднозначно. Промоут не выполнен:`,
      matched.map((c) => ({ id: c.id, name: c.name })),
    )
    process.exit(3)
  }

  const target = matched[0]

  if (target.role === 'ADMIN_PRO') {
    console.log(`✓ ${target.name} уже ADMIN_PRO. Ничего не делаем.`)
    process.exit(0)
  }

  await prisma.user.update({
    where: { id: target.id },
    data: { role: 'ADMIN_PRO' },
  })
  console.log(`✅ Promoted: ${target.name} -> ADMIN_PRO`)
  process.exit(0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
