import { NextResponse, type NextRequest } from 'next/server'
import type { Update } from 'grammy/types'
import { getTelegramBot } from '@/lib/telegram/bot'
import { getTelegramEnv } from '@/lib/telegram/env'

// grammy не работает на edge — явно фиксируем Node.js runtime.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  let webhookSecret: string
  try {
    webhookSecret = getTelegramEnv().webhookSecret
  } catch (err) {
    console.error('[telegram] webhook: env not configured', err)
    // 200 чтобы Telegram не накручивал ретраи на нашу мисконфигурацию
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  const headerSecret = req.headers.get('x-telegram-bot-api-secret-token')
  if (headerSecret !== webhookSecret) {
    console.warn('[telegram] webhook: invalid secret token')
    return new NextResponse('unauthorized', { status: 401 })
  }

  let update: Update
  try {
    update = (await req.json()) as Update
  } catch (err) {
    console.warn('[telegram] webhook: invalid json', err)
    return new NextResponse('bad request', { status: 400 })
  }

  try {
    const bot = await getTelegramBot()
    await bot.handleUpdate(update)
  } catch (err) {
    // Не пробрасываем 5xx — Telegram начал бы ретраить с экспоненциальным
    // бэкоффом, нам это не нужно: ошибка уже залогирована.
    console.error('[telegram] handleUpdate failed:', err)
  }

  return new NextResponse('ok', { status: 200 })
}

export async function GET(): Promise<NextResponse> {
  return new NextResponse('method not allowed', { status: 405 })
}
