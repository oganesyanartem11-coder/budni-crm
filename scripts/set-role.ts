import { PrismaClient, UserRole } from '@prisma/client'

const prisma = new PrismaClient()

const VALID_ROLES: UserRole[] = ['ADMIN', 'MANAGER', 'CHEF', 'COURIER']

async function main() {
  const role = (process.argv[2] || '').toUpperCase() as UserRole

  if (!VALID_ROLES.includes(role)) {
    console.error(`✗ Некорректная роль: "${process.argv[2]}"`)
    console.error(`  Допустимые: ${VALID_ROLES.join(', ')}`)
    console.error(`  Использование: npx tsx scripts/set-role.ts <ROLE>`)
    process.exit(1)
  }

  // Берём первого активного пользователя (порядок создания) — для local-dev этого достаточно.
  // Если нужен конкретный — отредактируй фильтр (например по name="Dev Admin (PIN 1111)").
  const user = await prisma.user.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  })

  if (!user) {
    console.error('✗ В БД нет активных пользователей. Сначала запусти npx tsx scripts/create-dev-admin.ts')
    process.exit(1)
  }

  const before = user.role
  if (before === role) {
    console.log(`= Пользователь "${user.name}" уже имеет роль ${role} — изменений нет.`)
    return
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { role },
  })

  console.log(`✓ Роль изменена: ${before} → ${role}`)
  console.log(`  Пользователь: ${user.name} (id: ${user.id})`)
  console.log(`  Перелогиньтесь в /login чтобы пересчитать ACL/редиректы.`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('✗ Ошибка:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
