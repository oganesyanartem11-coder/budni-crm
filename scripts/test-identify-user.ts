/**
 * 7.16.A.1 (блок A3): smoke-typecheck для identify-user.
 *
 * Не запускается через раннер — нужен только для проверки, что
 * сигнатуры identifyTelegramUser / requireTelegramUser стабильны
 * и совместимы с grammy Context. Запуск: `npx tsc --noEmit`.
 */
import type { Context } from 'grammy'
import {
  identifyTelegramUser,
  requireTelegramUser,
  type IdentifiedUser,
} from '@/lib/telegram/identify-user'

async function main() {
  // Фейковый ctx — реально не вызывается, нужен только для typecheck.
  const fakeCtx = {
    from: { id: 123456789 },
    reply: async (_text: string) => undefined,
  } as unknown as Context

  const u1: IdentifiedUser | null = await identifyTelegramUser(fakeCtx)
  console.log('[test-identify-user] identify:', u1)

  const u2: IdentifiedUser | null = await requireTelegramUser(fakeCtx)
  console.log('[test-identify-user] require (any role):', u2)

  const u3: IdentifiedUser | null = await requireTelegramUser(fakeCtx, [
    'ADMIN_PRO',
    'ADMIN',
    'MANAGER',
  ])
  console.log('[test-identify-user] require (admin/manager):', u3)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
