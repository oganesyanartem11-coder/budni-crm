/**
 * Smoke-тест для callback-router. НЕ запускать в проде/CI — только для ручной типизации.
 *
 * Usage: npx tsx scripts/test-callback-router.ts
 */
import type { Context } from 'grammy'
import {
  registerCallbackHandler,
  dispatchCallback,
} from '@/lib/telegram/callback-router'

type AnswerArgs = { text?: string; show_alert?: boolean } | undefined

interface FakeCtx {
  callbackQuery: { data: string }
  answerCallbackQuery: (args?: AnswerArgs) => Promise<void>
}

async function run(): Promise<void> {
  let handlerCalledWith: { action: string; id: string } | null = null
  const answerCalls: AnswerArgs[] = []

  registerCallbackHandler({
    scope: 'boris',
    handle: async (_ctx, action, id) => {
      handlerCalledWith = { action, id }
    },
  })

  const fakeCtx: FakeCtx = {
    callbackQuery: { data: 'boris:confirm:cmpending123' },
    answerCallbackQuery: async (args) => {
      answerCalls.push(args)
    },
  }

  // Cast через unknown, потому что Context — это полноценный grammy-объект,
  // мокать его целиком слишком тяжело.
  await dispatchCallback(fakeCtx as unknown as Context)

  console.log('handler called with:', handlerCalledWith)
  console.log('answer calls:', answerCalls)

  if (!handlerCalledWith) {
    throw new Error('handler не был вызван')
  }
  if (
    (handlerCalledWith as { action: string; id: string }).action !== 'confirm' ||
    (handlerCalledWith as { action: string; id: string }).id !== 'cmpending123'
  ) {
    throw new Error('handler получил неверные аргументы')
  }
  if (answerCalls.length !== 1 || answerCalls[0] !== undefined) {
    throw new Error('финальный answerCallbackQuery() должен быть вызван 1 раз без аргументов')
  }

  console.log('OK')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
