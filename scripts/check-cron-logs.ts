import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const dbInfo = await prisma.$queryRawUnsafe<Array<{ db: string }>>(
    'SELECT current_database() AS db'
  )
  console.log('Connected to DB:', dbInfo[0]?.db)

  const threeDaysAgo = new Date()
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)

  const cronActions = [
    'BOT_CRON_SUMMARY',
    'PRODUCTION_SUMMARY_SENT',
    'END_OF_DAY_DIGEST_SENT',
  ]

  const logs = await prisma.activityLog.findMany({
    where: {
      action: { in: cronActions },
      createdAt: { gte: threeDaysAgo },
    },
    select: {
      id: true,
      action: true,
      entityId: true,
      payload: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  console.log(`Found ${logs.length} cron log entries since ${threeDaysAgo.toISOString()}:`)
  for (const log of logs) {
    console.log('---')
    console.log(`${log.createdAt.toISOString()} | ${log.action} | entityId=${log.entityId}`)
    console.log('payload:', JSON.stringify(log.payload, null, 2))
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
