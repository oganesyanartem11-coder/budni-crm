import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  // Артёма ищем по role=ADMIN_PRO (один такой)
  const artem = await prisma.user.findFirst({
    where: { role: 'ADMIN_PRO', isActive: true },
  })
  if (!artem) {
    console.error('ADMIN_PRO user not found')
    process.exit(1)
  }

  await prisma.user.update({
    where: { id: artem.id },
    data: { receivesToneAlerts: true },
  })

  console.log(`✅ Enabled tone alerts for: ${artem.name} (${artem.id})`)
}

main().finally(() => prisma.$disconnect())
