import Anthropic from '@anthropic-ai/sdk'
import { getAnthropicClient } from '@/lib/llm/client'
import { getInboxModel } from '@/lib/ai/models'
import { toMskDateString, getMskCalendarDayUtc } from '@/lib/utils/msk-window'

/**
 * MEGA-4b (П3): классификатор «запрос на изменение количества порций?».
 *
 * Клиент пишет в чат свободным текстом. parseChangeIntent одним Haiku-вызовом
 * (tool_use submit_change_intent) решает: это явный запрос «N порций на дату X»
 * (action=CHANGE) или нет (action=NONE). НЕ исполняет — только классифицирует;
 * менеджер проверит созданный PendingOrderChange.
 *
 * Постпроцессинг страхует от LLM-багов: неполнота, прошлая дата, слишком
 * далёкое будущее, диапазон порций, неизвестный тип еды. Любая ошибка вызова
 * или парсинга → NONE (fail-safe, как в tone-classifier).
 */

export type MealType = 'ЗАВТРАК' | 'ОБЕД' | 'УЖИН'

export type ChangeIntent =
  | {
      action: 'CHANGE'
      portions: number
      date: string // YYYY-MM-DD МСК
      mealType: MealType | null
      confidence: number
      reason: string
    }
  | { action: 'NONE'; reason: string }

const CHANGE_TOOL: Anthropic.Messages.Tool = {
  name: 'submit_change_intent',
  description:
    'Классифицировать сообщение клиента: запрос на изменение количества порций (CHANGE) или нет (NONE).',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['CHANGE', 'NONE'] },
      portions: { type: ['number', 'null'], minimum: 1, maximum: 1000 },
      date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      mealType: {
        type: ['string', 'null'],
        enum: ['ЗАВТРАК', 'ОБЕД', 'УЖИН', null],
      },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['action', 'confidence', 'reason'],
  },
}

function buildSystemPrompt(
  clientName: string,
  todayStr: string,
  availableMealTypes: MealType[],
): string {
  return `Ты — ассистент кейтеринг-сервиса Будни. Клиент ${clientName} написал сообщение в чат. Сегодня ${todayStr} (МСК).

Определи: это запрос на изменение количества порций или создание нового заказа?

Возвращай action='CHANGE' ТОЛЬКО когда клиент явно указал:
- Количество порций (целое число)
- Дату (на завтра, в пятницу, 12.06, на 15-е) — конвертируй в YYYY-MM-DD по МСК
- ОДНУ дату с ОДНИМ числом (не «12 завтра и 14 в пятницу» — это NONE)

Если упомянут тип еды (завтрак/обед/ужин) — извлеки в mealType. У этого клиента активны: ${availableMealTypes.join(', ')}. Если только один тип активен → mealType=null (используется тот единственный). Если клиент активен на >1 типе и в тексте тип не указан → mealType=null (это потом обработает менеджер).

Возвращай action='NONE' когда:
- Только число без даты («надо 13»)
- Только дата без числа («на пятницу»)
- Несколько дат одним сообщением
- Сомнения, опечатки, нестандартный язык
- Тон расстроенный или гневный
- Запрос отмены, переноса, жалоба, благодарность
- НЕ можешь однозначно конвертировать дату в YYYY-MM-DD

Confidence ≥ 0.95 — твёрдо уверен. < 0.85 — обязательно NONE.

Примеры:
1. «надо 13 обедов на завтра» (сегодня 04.06.2026) → CHANGE portions=13 date=2026-06-05 mealType=ОБЕД confidence=0.97
2. «давайте 7 на пятницу» (сегодня среда 04.06) → CHANGE portions=7 date=2026-06-06 mealType=null confidence=0.93
3. «сделай 15 на 06.06» → CHANGE portions=15 date=2026-06-06 mealType=null confidence=0.96
4. «надо 13» → NONE (нет даты)
5. «отмените завтра» → NONE (это отмена)
6. «12 завтра и 14 в пятницу» → NONE
7. «спасибо!» → NONE
8. «через пол часа» → NONE
9. «завтрак 5 на 06.06» → CHANGE portions=5 date=2026-06-06 mealType=ЗАВТРАК confidence=0.96

ВАЖНО: ты НЕ исполняешь. Только классифицируешь. Менеджер проверит.`
}

interface RawIntent {
  action?: string
  portions?: number | null
  date?: string | null
  mealType?: string | null
  confidence?: number
  reason?: string
}

const NONE = (reason: string): ChangeIntent => ({ action: 'NONE', reason })

export async function parseChangeIntent(
  text: string,
  context: {
    clientName: string
    today: Date // МСК
    availableMealTypes: MealType[]
  },
): Promise<ChangeIntent> {
  const todayStr = toMskDateString(context.today)
  const systemPrompt = buildSystemPrompt(
    context.clientName,
    todayStr,
    context.availableMealTypes,
  )

  let raw: RawIntent
  try {
    const client = getAnthropicClient()
    const response = await client.messages.create({
      model: getInboxModel(),
      max_tokens: 300,
      system: systemPrompt,
      tools: [CHANGE_TOOL],
      tool_choice: { type: 'tool', name: 'submit_change_intent' },
      messages: [{ role: 'user', content: text.slice(0, 1000) }],
    })

    const toolUse = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
    )
    if (!toolUse || toolUse.name !== 'submit_change_intent') {
      console.warn(
        `[parse-change-intent] no tool_use, stop_reason=${response.stop_reason}`,
      )
      return NONE('parse_error')
    }
    raw = toolUse.input as RawIntent
  } catch (e) {
    console.error('[parse-change-intent] failed:', e)
    return NONE('parse_error')
  }

  // ── Постпроцессинг: защита от LLM-багов ──
  if (raw.action !== 'CHANGE') {
    return NONE(typeof raw.reason === 'string' ? raw.reason : 'not_a_change')
  }

  const { portions, date, confidence } = raw
  const conf = typeof confidence === 'number' ? confidence : 0

  // Неполнота: нет порций / нет даты / низкая уверенность.
  if (
    portions == null ||
    date == null ||
    typeof portions !== 'number' ||
    conf < 0.85
  ) {
    return NONE('incomplete')
  }

  // Диапазон порций.
  if (portions <= 0 || portions > 1000) {
    return NONE('out_of_range')
  }

  // Дата валидна по формату.
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NONE('incomplete')
  }

  // ── Сравнения дат строго в МСК (по календарным дням) ──
  // Парсим YYYY-MM-DD LLM-даты как UTC-полночь календарной даты (тот же
  // контракт, что и getMskCalendarDayUtc — UTC-полночь МСК-календарного дня).
  const requestedUtc = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(requestedUtc.getTime())) {
    return NONE('incomplete')
  }
  const todayUtc = getMskCalendarDayUtc(context.today, 0)
  const maxUtc = getMskCalendarDayUtc(context.today, 14)

  if (requestedUtc.getTime() < todayUtc.getTime()) {
    return NONE('past_date')
  }
  if (requestedUtc.getTime() > maxUtc.getTime()) {
    return NONE('too_far_future')
  }

  // Тип еды.
  let mealType: MealType | null = null
  if (raw.mealType != null) {
    if (
      raw.mealType !== 'ЗАВТРАК' &&
      raw.mealType !== 'ОБЕД' &&
      raw.mealType !== 'УЖИН'
    ) {
      return NONE('unknown_meal_type')
    }
    if (!context.availableMealTypes.includes(raw.mealType)) {
      return NONE('unknown_meal_type')
    }
    mealType = raw.mealType
  }

  return {
    action: 'CHANGE',
    portions,
    date,
    mealType,
    confidence: conf,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
  }
}
