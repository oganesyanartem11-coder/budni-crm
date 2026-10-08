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
      /** mode='add' — изменение со знаком («добавьте 2» → 2, «уберите 3» → -3). */
      portions: number
      mode: 'set' | 'add'
      date: string // YYYY-MM-DD МСК (для периода — первый день)
      /** Последний день периода включительно («с 7 по 14»); null — одна дата. */
      dateTo: string | null
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
      portions: { type: ['number', 'null'] },
      mode: { type: 'string', enum: ['set', 'add'] },
      date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      dateTo: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      mealType: {
        type: ['string', 'null'],
        enum: ['ЗАВТРАК', 'ОБЕД', 'УЖИН', null],
      },
      confidence: { type: 'number' },
      reason: { type: 'string', description: 'Одно короткое предложение, до 100 символов' },
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
- ИЛИ ПЕРИОД с ОДНИМ изменением на все его дни: «с 7 по 14 +1 обед», «с понедельника по пятницу по 30», «всю следующую неделю на 2 меньше» → date = первый день, dateTo = последний день (включительно). Одна дата → dateTo=null. «С 7-го» без конца периода — dateTo=null (одна дата 7-го не подразумевается — это NONE, если конец не понятен).

Если клиент просит ДОБАВИТЬ или УБРАТЬ порции к уже заказанному («добавьте 2 на завтра», «+1 обед в пятницу», «на 3 меньше завтра», «уберите одну на 08.10») — это тоже CHANGE: mode='add', portions = изменение со знаком (добавить 2 → 2, убрать 3 → -3). Если клиент называет итоговое количество — mode='set'.

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
9. «завтрак 5 на 06.06» → CHANGE portions=5 date=2026-06-06 mealType=ЗАВТРАК confidence=0.96 mode=set
10. «на завтра добавьте 2 обеда» (сегодня 04.06) → CHANGE portions=2 mode=add date=2026-06-05 mealType=ОБЕД confidence=0.95
11. «в пятницу на 3 меньше» (сегодня среда 04.06) → CHANGE portions=-3 mode=add date=2026-06-06 mealType=null confidence=0.95
12. «с 8 по 12 июня +1 обед» (сегодня 04.06) → CHANGE portions=1 mode=add date=2026-06-08 dateTo=2026-06-12 mealType=ОБЕД confidence=0.96
13. «на следующей неделе каждый день по 30» (сегодня среда 04.06) → CHANGE portions=30 mode=set date=2026-06-08 dateTo=2026-06-14 mealType=null confidence=0.93
14. «с понедельника добавьте 2» (без конца) → NONE

ВАЖНО: ты НЕ исполняешь. Только классифицируешь. Менеджер проверит.`
}

interface RawIntent {
  action?: string
  portions?: number | null
  mode?: string | null
  date?: string | null
  dateTo?: string | null
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
      // запас: Haiku 5.5 пишет длинный reason, обрыв tool_use = NONE
      max_tokens: 1000,
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

  // Диапазон порций (для «добавьте/уберите» — ненулевое целое изменение).
  const mode: 'set' | 'add' = raw.mode === 'add' ? 'add' : 'set'
  if (!Number.isInteger(portions)) return NONE('out_of_range')
  if (mode === 'add' ? portions === 0 || Math.abs(portions) > 1000 : portions <= 0 || portions > 1000) {
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

  // Период «с 7 по 14»: начало в прошлом подрезаем до сегодня (прошедшие дни
  // всё равно не меняются), конец — не дальше 31 дня.
  let startDate = date
  let dateTo: string | null = null
  if (typeof raw.dateTo === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.dateTo) && raw.dateTo !== date) {
    const toUtc = new Date(`${raw.dateTo}T00:00:00.000Z`)
    if (Number.isNaN(toUtc.getTime()) || toUtc.getTime() < requestedUtc.getTime()) return NONE('incomplete')
    if (toUtc.getTime() < todayUtc.getTime()) return NONE('past_date')
    if (toUtc.getTime() > getMskCalendarDayUtc(context.today, 31).getTime()) return NONE('too_far_future')
    if (requestedUtc.getTime() < todayUtc.getTime()) startDate = todayUtc.toISOString().slice(0, 10)
    dateTo = raw.dateTo
  } else {
    if (requestedUtc.getTime() < todayUtc.getTime()) {
      return NONE('past_date')
    }
    if (requestedUtc.getTime() > maxUtc.getTime()) {
      return NONE('too_far_future')
    }
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
    mode,
    date: startDate,
    dateTo,
    mealType,
    confidence: conf,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
  }
}
