import { NextResponse, type NextRequest } from 'next/server'
import type { Update } from 'grammy/types'
import { getTelegramBot } from '@/lib/telegram/bot'
import { getTelegramEnv } from '@/lib/telegram/env'
import { withDbRetry } from '@/lib/db-retry'

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
    // P1001-фикс: на холодном Neon первый DB-запрос внутри grammy-хендлера
    // падает с P1001 ДО любой отправки сообщения. Ретраим update — прогреваем
    // compute. Ретрай срабатывает только на P1001/P1002, поэтому двойной
    // отправки не будет (на cold-start падение происходит до сайд-эффектов).
    await withDbRetry(() => bot.handleUpdate(update), { label: 'telegram-webhook' })
  } catch (err) {
    // Не пробрасываем 5xx — Telegram начал бы ретраить с экспоненциальным
    // бэкоффом, нам это не нужно: ошибка уже залогирована.
    console.error('[telegram] handleUpdate failed:', err)
    // 7.12: репорт в in-house tracker.
    void import('@/lib/errors/tracker').then((m) =>
      m.trackError({
        error: err,
        request: { url: req.url, method: 'POST' },
        extra: { source: 'telegram/webhook' },
      })
    )
  }

  return new NextResponse('ok', { status: 200 })
}

export async function GET(): Promise<NextResponse> {
  return new NextResponse('method not allowed', { status: 405 })
}
