import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  const dbInfo = await prisma.$queryRawUnsafe<Array<{ db: string }>>(
    'SELECT current_database() AS db'
  )
  console.log('Connected to DB:', dbInfo[0]?.db)

  // pinHash @unique — пробуем несколько PIN'ов на случай коллизии хеша.
  const candidates = ['1111', '2222', '3333']

  for (const pin of candidates) {
    const pinHash = await bcrypt.hash(pin, 10)
    const existing = await prisma.user.findFirst({
      where: { name: 'Dev Admin (PIN ' + pin + ')' },
    })

    try {
      if (existing) {
        await prisma.user.update({
          where: { id: existing.id },
          data: { pinHash, role: 'ADMIN', isActive: true },
        })
        console.log(`✓ Обновлён существующий Dev Admin, PIN = ${pin}`)
        console.log('  ID:', existing.id)
        return
      }
      const user = await prisma.user.create({
        data: {
          name: 'Dev Admin (PIN ' + pin + ')',
          role: 'ADMIN',
          pinHash,
          isActive: true,
        },
      })
      console.log('✓ Создан Dev Admin')
      console.log('  ID:', user.id)
      console.log('  PIN:', pin)
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('P2002')) {
        console.warn(`✗ PIN ${pin}: коллизия hash (P2002), пробую следующий…`)
        continue
      }
      throw e
    }
  }

  throw new Error('Все кандидатные PIN-ы дали P2002. Очень странно.')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('✗ Ошибка:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
