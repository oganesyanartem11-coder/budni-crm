import type { Context, FilteredContext } from '@maxhub/max-bot-api'

/**
 * Эхо-режим для smoke-теста цепочки MAX → Vercel → MAX.
 * Реальная бизнес-логика (LLM-парсинг, inbox эскалация) — Спринты 5.2-5.9.
 */
export async function handleMessage(ctx: FilteredContext<Context, 'message_created'>): Promise<void> {
  const text = ctx.message?.body?.text ?? ''
  const chatId = ctx.chatId
  console.log(`[MAX] message_created chat=${chatId} text=${JSON.stringify(text).slice(0, 200)}`)
  await ctx.reply(`echo: ${text}`)
}

/**
 * Событие при первом старте бота клиентом (deep-link onboarding).
 * Payload (если есть) — onboarding-токен, который мы свяжем с Client.maxChatId
 * в Спринте 5.4.
 */
export async function handleBotStarted(ctx: FilteredContext<Context, 'bot_started'>): Promise<void> {
  const chatId = ctx.chatId
  const payload = ctx.startPayload
  console.log(`[MAX] bot_started chat=${chatId} payload=${payload ?? 'none'}`)
  await ctx.reply('Здравствуйте! Это бот компании «Будни». В будущем здесь будет ежедневный приём заказов.')
}
