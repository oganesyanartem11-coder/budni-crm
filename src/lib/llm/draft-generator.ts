import { getAnthropicClient, LLM_MODEL } from './client'
import type { BotMessageDirection } from '@prisma/client'

export interface GenerateDraftInput {
  clientName: string
  clientMessages: Array<{ direction: BotMessageDirection; text: string; createdAt: Date }>
  conversationContext?: string
}

export async function generateDraftReply(input: GenerateDraftInput): Promise<string> {
  const client = getAnthropicClient()

  const systemPrompt = `Ты помогаешь менеджеру кейтеринг-компании «Будни» отвечать клиентам.
Кейтеринг доставляет обеды юрлицам (заводы, школы, офисы).
Менеджер увидит твой ответ как draft и сможет одобрить, отредактировать или отклонить.

ПРАВИЛА:
1. Отвечай от лица компании, без местоимения «я».
2. Тон вежливый, профессиональный, краткий. Не дружеский «привет», но и не сухой.
3. Если клиент задал вопрос — отвечай по существу или предложи передать менеджеру (если ответ требует данных которых ты не знаешь).
4. НЕ выдумывай факты: цены, время доставки, наличие блюд. Если не знаешь — пиши «уточним и сообщим».
5. НЕ обещай скидки, бонусы, исключения.
6. Длина: 1-3 предложения. Без подписи.
7. На грубость — спокойно и нейтрально, без оправданий.

Верни ТОЛЬКО текст ответа клиенту, без обёрток, кавычек, форматирования.`

  const messagesText = input.clientMessages
    .slice(-10)
    .map((m) => {
      const author =
        m.direction === 'IN' ? input.clientName :
        m.direction === 'OUT' ? 'Бот (автоматический ответ)' :
        'Менеджер'
      return `[${author}]: ${m.text}`
    })
    .join('\n')

  const userPrompt = `Клиент: ${input.clientName}
${input.conversationContext ? `Контекст: ${input.conversationContext}\n` : ''}
Последние сообщения в переписке:
${messagesText}

Напиши draft ответа клиенту на последнее его сообщение.`

  const response = await client.messages.create({
    model: LLM_MODEL,
    max_tokens: 300,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM returned no text content')
  }
  return textBlock.text.trim()
}
