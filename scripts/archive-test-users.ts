import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const TEST_USER_NAMES = [
  'свсвс',
  'Тестовый Иван',
  'ааа',
  'Тест менеджер',
  'вувцвц',
  'Лох',
  'Dddss',
  'Тест1',
  'епепепе',
  'Тест курьер',
]

async function main() {
  const users = await prisma.user.findMany({
    where: { name: { in: TEST_USER_NAMES }, isActive: true },
    select: { id: true, name: true, role: true },
  })

  console.log(`Найдено активных тест-юзеров: ${users.length}`)
  for (const u of users) {
    console.log(`  - ${u.name} (${u.role}) [${u.id}]`)
  }

  if (users.length === 0) {
    console.log('Нечего archive')
    return
  }

  // CONFIRMATION: запросить через ENV CONFIRM=yes
  if (process.env.CONFIRM !== 'yes') {
    console.log('\n⚠️ Запусти с CONFIRM=yes чтобы реально archive')
    return
  }

  await prisma.user.updateMany({
    where: { id: { in: users.map((u) => u.id) } },
    data: { isActive: false },
  })

  console.log(`\n✅ Archived ${users.length} тест-юзеров (isActive=false)`)
}

main().finally(() => prisma.$disconnect())
