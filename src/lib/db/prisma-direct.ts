import { PrismaClient } from '@prisma/client'

// Отдельный клиент на прямом соединении (без pooler) для interactive transactions.
// Neon pooler (pgbouncer transaction-mode) не поддерживает $transaction(callback) —
// сессия закрывается после каждого запроса, и Prisma теряет tx ID (P2028).
// Использовать ТОЛЬКО для редких операций (импорт меню — раз в 2 недели).
// Обычные запросы приложения идут через основной prisma (pooler).
const globalForPrismaDirect = globalThis as unknown as {
  prismaDirect: PrismaClient | undefined
}

export const prismaDirect =
  globalForPrismaDirect.prismaDirect ??
  new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL } },
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrismaDirect.prismaDirect = prismaDirect
}
