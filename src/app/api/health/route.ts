import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type DbStatus = { alive: boolean; lastMigration?: string; error?: string }
type TelegramStatus = { alive: boolean; error?: string }

const STEP_TIMEOUT_MS = 3_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

async function checkDb(): Promise<DbStatus> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, STEP_TIMEOUT_MS, 'db-ping')
    try {
      const rows = await withTimeout(
        prisma.$queryRaw<Array<{ migration_name: string }>>`
          SELECT migration_name FROM _prisma_migrations
          ORDER BY finished_at DESC NULLS LAST LIMIT 1
        `,
        STEP_TIMEOUT_MS,
        'db-migration',
      )
      return { alive: true, lastMigration: rows[0]?.migration_name }
    } catch {
      // База жива, но не смогли прочитать миграции — не критично.
      return { alive: true }
    }
  } catch (err) {
    return { alive: false, error: err instanceof Error ? err.message : 'unknown' }
  }
}

async function checkTelegram(): Promise<TelegramStatus> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    return { alive: false, error: 'TELEGRAM_BOT_TOKEN not configured' }
  }
  try {
    const res = await withTimeout(
      fetch(`https://api.telegram.org/bot${token}/getMe`),
      STEP_TIMEOUT_MS,
      'telegram-getMe',
    )
    if (!res.ok) {
      return { alive: false, error: `getMe status ${res.status}` }
    }
    return { alive: true }
  } catch (err) {
    return { alive: false, error: err instanceof Error ? err.message : 'unknown' }
  }
}

export async function GET(request: Request) {
  const expectedSecret = process.env.HEALTH_CHECK_SECRET
  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const [dbResult, telegramResult] = await Promise.allSettled([checkDb(), checkTelegram()])

  const db: DbStatus =
    dbResult.status === 'fulfilled'
      ? dbResult.value
      : { alive: false, error: dbResult.reason instanceof Error ? dbResult.reason.message : 'unknown' }

  const telegram: TelegramStatus =
    telegramResult.status === 'fulfilled'
      ? telegramResult.value
      : {
          alive: false,
          error:
            telegramResult.reason instanceof Error ? telegramResult.reason.message : 'unknown',
        }

  const ok = db.alive && telegram.alive

  return NextResponse.json(
    {
      ok,
      db,
      telegram,
      checkedAt: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  )
}
