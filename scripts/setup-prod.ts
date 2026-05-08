import { PrismaClient } from '@prisma/client'
import { hashPin } from '../src/lib/auth/pin'

const prisma = new PrismaClient()

async function main() {
  const adminPin = process.env.ADMIN_PIN
  const adminName = process.env.ADMIN_NAME ?? 'Администратор'

  if (!adminPin || adminPin.length < 4) {
    console.error('❌ ADMIN_PIN env required (4+ digits)')
    process.exit(1)
  }

  const existing = await prisma.user.count({ where: { role: 'ADMIN' } })
  if (existing > 0) {
    console.log(`⚠️  ${existing} admin user(s) already exist. Skipping.`)
    return
  }

  const pinHash = await hashPin(adminPin)
  const admin = await prisma.user.create({
    data: { pinHash, name: adminName, role: 'ADMIN' },
  })

  console.log(`✅ Admin created: ${admin.name} (PIN: ${adminPin})`)
  console.log(`   ID: ${admin.id}`)
  console.log(`   Use this PIN to log in. Save it securely.`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
