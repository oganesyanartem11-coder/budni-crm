import { getAnthropicClient } from './client'
import { getParserModel, getFallbackModel } from '@/lib/ai/models'
import { callWithFallback } from '@/lib/ai/with-fallback'

export interface ScheduleEntry {
  week: number
  day: string
  meal: string
  slot: string
  dishName: string
}

export interface MenuScheduleOutput {
  entries: ScheduleEntry[]
  uniqueDishes: string[]
  confidence: number
  reason: string
  rawLlmResponse: string
}

export async function parseMenuSchedule(rawMenuText: string): Promise<MenuScheduleOutput> {
  const client = getAnthropicClient()

  const systemPrompt = `Ты разбираешь меню кейтеринг-компании «Будни», извлечённое из Excel или фото.
Текст — сырой дамп ячеек, структура может быть любой: разное число недель, разный порядок дней, обед и ужин могут идти в одной таблице или в разных блоках. Понимай смысл, не полагайся на фиксированные позиции строк или колонок.
Твоя задача — извлечь расписание: для каждой ячейки с названием блюда определить номер недели, день недели, приём пищи (обед/ужин), слот (Суп / Горячее / Салат / Напиток / Доп.блюдо / иное), название блюда.

ПРАВИЛА:
1. Возвращай ВАЛИДНЫЙ JSON, ничего кроме JSON.
2. week — целое число начиная с 1 (первый недельный блок=1, следующий=2 и т.д.). Если в таблице явно несколько недельных блоков — нумеруй по порядку их появления сверху вниз.
3. day — полное русское название дня недели: Понедельник, Вторник, Среда, Четверг, Пятница, Суббота, Воскресенье.
4. meal — "обед" или "ужин". Если в тексте есть пометка ужин над колонками или в шапке блока — те колонки относятся к ужину, остальные к обеду. Если непонятно — "обед".
5. slot — назначение блюда: Суп, Горячее, Салат, Напиток, Доп.блюдо. Если в шапке колонки указано другое слово — используй его как есть.
6. dishName — название блюда РОВНО как в ячейке (не нормализуй, не сокращай, не исправляй опечатки — сохрани как написано).
7. Пустые ячейки, заголовки таблицы, строки-разделители, подписи "обед"/"ужин" — пропускай, не создавай записей для них.
8. uniqueDishes — список уникальных названий блюд (одно название один раз) для дальнейшей генерации техкарт.
9. confidence 0..1 — уверенность в разборе расписания в целом. reason — кратко: сколько недель и дней распознал, что вызвало сомнение (НЕ перечисляй все блюда).

Формат ответа:
{
  "entries": [
    {"week": 1, "day": "Понедельник", "meal": "обед", "slot": "Суп", "dishName": "..."}
  ],
  "uniqueDishes": ["...", "..."],
  "confidence": 0.0-1.0,
  "reason": "..."
}`

  const userPrompt = `Сырой текст меню:

${rawMenuText}

Разбери структуру. Верни JSON.`

  const startTime = Date.now()

  // System prompt стабильный — отдаём массивом с cache_control ephemeral.
  // На Opus 4.7 минимальный кэшируемый префикс ~4096 токенов; если текущий
  // системник короче, Anthropic тихо пропустит кэш (никакой ошибки),
  // cache_read_input_tokens останется 0. Не вредит — будет работать как
  // обычный вызов. См. usage.cache_read_input_tokens в логах.
  const cachedSystem = [
    { type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } },
  ]

  const response = await callWithFallback(
    () =>
      client.messages.create({
        model: getParserModel(),
        max_tokens: 16000,
        system: cachedSystem,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    () =>
      client.messages.create({
        model: getFallbackModel(),
        max_tokens: 16000,
        system: cachedSystem,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    'parseMenuSchedule'
  )

  const elapsed = Date.now() - startTime
  console.log(
    `[LLM] menu schedule parse took ${elapsed}ms, ` +
      `stop_reason=${response.stop_reason ?? 'null'}, ` +
      `output_tokens=${response.usage.output_tokens ?? 0}, ` +
      `cache_read=${response.usage.cache_read_input_tokens ?? 0}, ` +
      `cache_write=${response.usage.cache_creation_input_tokens ?? 0}`
  )

  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM returned no text content')
  }
  const rawLlmResponse = textBlock.text

  const jsonText = rawLlmResponse
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    console.error('[LLM] menu-schedule-parser failed to parse JSON, raw:', rawLlmResponse)
    console.error(`[menu-schedule-parser] JSON.parse failed (stop_reason=${response.stop_reason ?? 'null'}), raw response (first 2000 chars):`, rawLlmResponse?.slice(0, 2000))
    return {
      entries: [],
      uniqueDishes: [],
      confidence: 0,
      reason: 'LLM вернул невалидный JSON',
      rawLlmResponse,
    }
  }

  const p = parsed as Record<string, unknown>

  const rawEntries = Array.isArray(p.entries) ? (p.entries as unknown[]) : []
  const entries: ScheduleEntry[] = rawEntries.flatMap((raw) => {
    const e = raw as Record<string, unknown>
    if (
      typeof e.week === 'number' &&
      e.week >= 1 &&
      typeof e.day === 'string' &&
      e.day.trim() !== '' &&
      typeof e.meal === 'string' &&
      e.meal.trim() !== '' &&
      typeof e.slot === 'string' &&
      e.slot.trim() !== '' &&
      typeof e.dishName === 'string' &&
      e.dishName.trim() !== ''
    ) {
      return [
        {
          week: e.week,
          day: e.day.trim(),
          meal: e.meal.trim(),
          slot: e.slot.trim(),
          dishName: e.dishName.trim(),
        },
      ]
    }
    return []
  })

  const rawUnique = Array.isArray(p.uniqueDishes) ? (p.uniqueDishes as unknown[]) : []
  const uniqueDishes = Array.from(
    new Set(
      rawUnique.flatMap((u) =>
        typeof u === 'string' && u.trim() !== '' ? [u.trim()] : []
      )
    )
  )

  return {
    entries,
    uniqueDishes,
    confidence: typeof p.confidence === 'number' ? p.confidence : 0,
    reason: typeof p.reason === 'string' ? p.reason : '',
    rawLlmResponse,
  }
}
