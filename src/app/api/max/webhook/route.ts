import { NextRequest, NextResponse } from 'next/server'
import type { Update } from '@maxhub/max-bot-api/types'
import { getMaxBot } from '@/lib/max/client'
import { handleMessage, handleBotStarted } from '@/lib/max/handlers'

export const dynamic = 'force-dynamic'
// 60 сек — потолок Hobby. Нужно из-за задержки 15-30 сек в sendBotMessage:
// при цепочке бот-OUT (например, escalated + reply) суммарно может уйти до
// ~50 сек, дефолтные 10 сек на Hobby обрывали бы webhook.
export const maxDuration = 60

// SDK не экспортирует webhook-хелпер, но в runtime у Bot есть метод handleUpdate
// (приватный в d.ts, но публично доступный в JS — см. node_modules/@maxhub/max-bot-api/dist/bot.js).
interface BotInternal {
  on: (event: string, handler: (ctx: unknown) => unknown) => unknown
  handleUpdate: (update: Update) => Promise<void>
  _handlersRegistered?: boolean
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-max-bot-api-secret')
  if (process.env.MAX_WEBHOOK_SECRET && secret !== process.env.MAX_WEBHOOK_SECRET) {
    console.warn('[MAX] webhook: invalid secret')
    return NextResponse.json({ error: 'invalid secret' }, { status: 401 })
  }

  let update: Update
  try {
    update = (await req.json()) as Update
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  console.log('[MAX] webhook update:', JSON.stringify(update).slice(0, 500))

  try {
    const bot = getMaxBot() as unknown as BotInternal
    // Регистрируем хендлеры один раз на singleton — composer хранит middleware
    // в инстансе, и повторная регистрация на каждый запрос привела бы к дубликатам.
    if (!bot._handlersRegistered) {
      bot.on('message_created', handleMessage as (ctx: unknown) => unknown)
      bot.on('bot_started', handleBotStarted as (ctx: unknown) => unknown)
      bot._handlersRegistered = true
    }
    await bot.handleUpdate(update)
  } catch (err) {
    console.error('[MAX] handler error:', err)
    // 200 чтобы MAX не ретраил — ошибки внутри логики наша забота
  }

  return NextResponse.json({ ok: true })
}

export async function GET() {
  return NextResponse.json({ status: 'ok', service: 'max-bot-webhook' })
}
