import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const TEST_USERS = [
  { name: 'Админ Дёмо',     role: 'ADMIN'   as const, pin: '1111' },
  { name: 'Менеджер Маша',   role: 'MANAGER' as const, pin: '2222' },
  { name: 'Шеф Сергей',      role: 'CHEF'    as const, pin: '3333' },
  { name: 'Курьер Костя',    role: 'COURIER' as const, pin: '4444' },
]

async function main() {
  console.log('🌱 Создаём тестовых пользователей...')

  for (const u of TEST_USERS) {
    const pinHash = await bcrypt.hash(u.pin, 10)

    // Проверяем, нет ли уже такого юзера (по имени)
    const existing = await prisma.user.findFirst({ where: { name: u.name } })

    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { pinHash, role: u.role, isActive: true },
      })
      console.log(`  ↻ Обновлён: ${u.name} (${u.role}) — PIN ${u.pin}`)
    } else {
      await prisma.user.create({
        data: {
          name: u.name,
          role: u.role,
          pinHash,
          isActive: true,
        },
      })
      console.log(`  ✓ Создан: ${u.name} (${u.role}) — PIN ${u.pin}`)
    }
  }

  console.log('')
  console.log('✅ Готово. Тестовые PIN-коды:')
  console.log('   1111 — Админ')
  console.log('   2222 — Менеджер')
  console.log('   3333 — Шеф')
  console.log('   4444 — Курьер')
}

main()
  .catch((e) => {
    console.error('❌ Ошибка seed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
