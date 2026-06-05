import { getAnthropicClient } from '@/lib/llm/client'
import { getInboxModel } from '@/lib/ai/models'

/**
 * Boris reorg: дешёвый Haiku-классификатор «относится ли это сообщение к Борису».
 *
 * Контекст: в рабочем чате Борис недавно ответил. Пришло новое сообщение БЕЗ
 * явного «Борис». Надо решить — это продолжение разговора с Борисом
 * (уточнение/спасибо/жалоба/вопрос про его работу) или люди просто говорят
 * между собой и Борису влезать не нужно.
 *
 * Используется только когда shouldRespondInGroup вернул needsHaiku=true
 * (мы внутри контекстного окна, прямого упоминания нет).
 *
 * Дёшево: модель — глобальный Haiku (getInboxModel), max_tokens=50, на выходе
 * один JSON-объект.
 *
 * FAIL-SAFE: при ЛЮБОЙ ошибке (network / rate-limit / битый JSON / нет API-ключа)
 * возвращаем { relates:false, confidence:0 } — то есть молчим. Лучше промолчать,
 * чем влезть в чужой разговор или упасть на webhook. НИКОГДА не бросаем.
 */

export interface ClassifyMessageInput {
  /** Новое сообщение пользователя (без явного упоминания Бориса). */
  text: string
  /** Последний ответ Бориса в этом чате — контекст для классификатора. */
  lastBorisReply?: string
}

export interface ClassifyMessageResult {
  relates: boolean
  confidence: number
}

const SYSTEM_PROMPT = `Ты — классификатор для рабочего чата кейтеринг-компании.

В чате есть бот-помощник Борис. Только что Борис что-то ответил. Затем пришло
новое сообщение от человека, в котором имя «Борис» НЕ упоминается напрямую.

Твоя задача — решить: это новое сообщение ОТНОСИТСЯ к Борису или нет?

ОТНОСИТСЯ (relates=true):
- продолжение/уточнение того, что Борис только что сказал
- благодарность Борису за ответ («спасибо», «отлично», «понял, спасибо»)
- жалоба/несогласие с ответом Бориса («это неправильно», «не то посчитал»)
- вопрос, явно адресованный Борису как продолжение темы

НЕ ОТНОСИТСЯ (relates=false):
- люди в чате говорят между собой, не про Бориса и не про его ответ
- новая независимая тема, не связанная с тем, что сказал Борис
- обычный рабочий обмен репликами между сотрудниками

Верни РОВНО один JSON-объект и ничего больше:
{"relates": true|false, "confidence": 0..1}`

const FAIL_SAFE: ClassifyMessageResult = { relates: false, confidence: 0 }

export async function classifyMessageRelatesToBoris(
  input: ClassifyMessageInput,
): Promise<ClassifyMessageResult> {
  try {
    const client = getAnthropicClient()

    const userPrompt = `${
      input.lastBorisReply
        ? `Последний ответ Бориса: "${input.lastBorisReply.slice(0, 500)}"\n\n`
        : 'Предыдущий ответ Бориса недоступен.\n\n'
    }Новое сообщение человека: "${input.text.slice(0, 500)}"

Относится ли новое сообщение к Борису? Верни JSON.`

    const response = await client.messages.create({
      model: getInboxModel(),
      max_tokens: 50,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })

    // C.6: лог стоимости — usage может отсутствовать при нестандартных ответах.
    console.info('[haiku-cost]', {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    })

    const textBlock = response.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return FAIL_SAFE
    }

    const jsonText = textBlock.text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/, '')
      .trim()

    const parsed = JSON.parse(jsonText) as Record<string, unknown>

    const relates = parsed.relates === true
    const rawConfidence = parsed.confidence
    const confidence =
      typeof rawConfidence === 'number' && rawConfidence >= 0 && rawConfidence <= 1
        ? rawConfidence
        : 0

    return { relates, confidence }
  } catch (e) {
    console.error('[context-classifier] failed:', e)
    return FAIL_SAFE
  }
}
