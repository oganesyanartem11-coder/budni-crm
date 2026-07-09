import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
  log: ['error'],
})

async function ping() {
  const ts = new Date().toISOString()
  try {
    await prisma.$queryRawUnsafe('SELECT 1')
    console.log(`[keepalive] ${ts} OK`)
  } catch (e) {
    const msg = String(e).split('\n')[0]
    console.log(`[keepalive] ${ts} FAIL (compute спит, ретрай через 20с): ${msg}`)
  }
}

process.on('SIGINT', async () => {
  console.log('\n[keepalive] SIGINT — disconnecting')
  await prisma.$disconnect().catch(() => {})
  process.exit(0)
})

ping()
setInterval(ping, 20000)
