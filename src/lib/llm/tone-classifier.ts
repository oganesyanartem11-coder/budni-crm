import Anthropic from '@anthropic-ai/sdk'
import { getAnthropicClient } from './client'
import { getInboxModel } from '@/lib/ai/models'
import { isCapsRude, type ToneLabel } from './parser'

/**
 * Lightweight классификатор тона для spontaneous-сообщений (7.15 hotfix #2).
 *
 * Используется в handleSpontaneous, где parseClientResponse не вызывается
 * (нет cron-conversation, нечего парсить). Без этого алёрты на rude/urgent
 * не триггерились бы для писем «в супе фекалии!!!», пришедших вне cron-флоу.
 *
 * Отдельный от parseClientResponse вызов: тут только tone, без structured
 * orders/items/locations — экономия токенов (max_tokens=50). Tool_use с
 * input_schema enum гарантирует валидное значение без JSON-парсинга.
 *
 * Fail-safe: при любой ошибке (network, rate limit, parse) → 'neutral'.
 * Лучше не алёртить ложно при сбое AI, чем падать на webhook.
 */

const TONE_TOOL: Anthropic.Messages.Tool = {
  name: 'submit_tone',
  description: 'Классифицировать тон сообщения клиента в кейтеринг-сервис.',
  input_schema: {
    type: 'object',
    properties: {
      tone: {
        type: 'string',
        enum: ['neutral', 'rude', 'thanks', 'urgent'],
        description:
          'Тон сообщения: neutral=спокойно/информативно/вопрос; rude=грубо/жалоба/недовольство/мат; thanks=благодарность/похвала; urgent=срочно требует реакции (отмена сегодня, проблема прямо сейчас, замена нужна сейчас).',
      },
    },
    required: ['tone'],
  },
}

const SYSTEM_PROMPT = `Ты классифицируешь тон сообщения клиента, который пишет кейтеринг-компании в мессенджере.

Категории:
- neutral: спокойное сообщение, вопрос, информация. Большинство сообщений сюда.
- rude: клиент недоволен, ругается, жалуется на качество, использует ругательства или CAPS LOCK в негативном контексте, риторические вопросы типа "вы что обалдели?!"
- thanks: благодарность, похвала ("спасибо большое!", "очень вкусно было сегодня")
- urgent: клиент требует срочной реакции прямо сейчас — отменить заказ сегодня, прислать замену немедленно, проблема прямо сейчас. НЕ urgent: вопрос о завтрашнем меню, плановая отмена на следующую неделю.

Если сомневаешься между rude и urgent — выбирай urgent, если есть требование "сделайте сейчас". Иначе rude.
Если сомневаешься между neutral и thanks — выбирай neutral.
Если сомневаешься между neutral и rude — выбирай rude только при явных признаках (мат, обвинения, CAPS LOCK в негативе).

Верни ровно одно значение через tool_use submit_tone.`

export async function classifyMessageTone(text: string): Promise<ToneLabel> {
  // Shortcut: CAPS LOCK >= 8 символов → сразу rude (та же эвристика что в parser.ts).
  if (isCapsRude(text)) {
    return 'rude'
  }

  // Очень короткие/пустые — neutral без AI-вызова.
  const trimmed = text.trim()
  if (trimmed.length < 2) {
    return 'neutral'
  }

  try {
    const client = getAnthropicClient()
    const response = await client.messages.create({
      model: getInboxModel(),
      max_tokens: 50,
      system: SYSTEM_PROMPT,
      tools: [TONE_TOOL],
      tool_choice: { type: 'tool', name: 'submit_tone' },
      messages: [{ role: 'user', content: trimmed.slice(0, 500) }],
    })

    const toolUse = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
    )
    if (!toolUse || toolUse.name !== 'submit_tone') {
      console.warn(`[tone-classifier] no tool_use, stop_reason=${response.stop_reason}`)
      return 'neutral'
    }

    const tone = (toolUse.input as { tone?: string }).tone
    if (tone === 'neutral' || tone === 'rude' || tone === 'thanks' || tone === 'urgent') {
      return tone
    }
    console.warn(`[tone-classifier] invalid tone returned: ${tone}`)
    return 'neutral'
  } catch (e) {
    console.error('[tone-classifier] failed:', e)
    return 'neutral'
  }
}
