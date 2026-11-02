/**
 * Единая точка выбора провайдера и моделей для AI-вызовов.
 *
 * Зачем env vars: A/B-тесты моделей без code-change, быстрое переключение
 * в случае инцидента (например, временно деградировать parser на Sonnet).
 *
 * Дефолты совпадают с текущим production-кодом, чтобы поведение проекта
 * без выставленных env осталось прежним.
 */

const DEFAULT_PARSER_MODEL = 'claude-opus-4-7'
const DEFAULT_RECIPES_MODEL = 'claude-opus-4-7'
// 08.10.2026: разбор сообщений клиентов (числа, изменения, тон, черновики) — Haiku 5.5.
const DEFAULT_INBOX_MODEL = 'claude-haiku-5-5'
const DEFAULT_OPENAI_INBOX_MODEL = 'gpt-6-luna'
const DEFAULT_FALLBACK_MODEL = 'claude-sonnet-4-6'
const DEFAULT_VISION_MODEL = 'claude-sonnet-4-6'
// 07.10.2026: Борис-ассистент (чат, утренний брифинг, самоанализ, посты команды) — Sonnet 5.
const DEFAULT_BORIS_MODEL = 'claude-sonnet-5'
const DEFAULT_BORIS_DIRECT_MODEL = 'claude-opus-4-8'
const DEFAULT_BORIS_DIRECT_LIGHT_MODEL = 'claude-sonnet-4-6'

/** parseMenuSchedule: разбор структуры меню из Excel/фото (Opus). */
export function getParserModel(): string {
  return process.env.ANTHROPIC_MODEL_PARSER ?? DEFAULT_PARSER_MODEL
}

/** generateRecipes: генерация техкарт по списку блюд (Opus). */
export function getRecipesModel(): string {
  return process.env.ANTHROPIC_MODEL_RECIPES ?? DEFAULT_RECIPES_MODEL
}

/** Ключ OpenAI включает Luna; явный выбор провайдера имеет приоритет. */
export function getInboxProvider(): 'openai' | 'anthropic' {
  const provider = process.env.INBOX_AI_PROVIDER?.trim()
  if (provider === 'openai' || provider === 'anthropic') return provider
  if (provider) throw new Error('INBOX_AI_PROVIDER must be openai or anthropic')
  return process.env.OPENAI_API_KEY?.trim() ? 'openai' : 'anthropic'
}

/** Клиентские сообщения: Luna через OpenAI либо прежний Haiku. */
export function getInboxModel(): string {
  if (getInboxProvider() === 'openai') {
    return process.env.OPENAI_MODEL_INBOX?.trim() || DEFAULT_OPENAI_INBOX_MODEL
  }
  return process.env.ANTHROPIC_MODEL_INBOX ?? DEFAULT_INBOX_MODEL
}

/** Независимый переключатель для чата, брифингов и отчётов Бориса. */
export function getBorisProvider(): 'openai' | 'anthropic' {
  const provider = process.env.BORIS_AI_PROVIDER?.trim()
  if (provider === 'openai' || provider === 'anthropic') return provider
  if (provider) throw new Error('BORIS_AI_PROVIDER must be openai or anthropic')
  return process.env.OPENAI_API_KEY?.trim() ? 'openai' : 'anthropic'
}

/** Используется при overloaded/5xx primary-модели в Opus-вызовах. */
export function getFallbackModel(): string {
  return process.env.ANTHROPIC_MODEL_FALLBACK ?? DEFAULT_FALLBACK_MODEL
}

/**
 * invoice-recognizer (7.14A) и прочие Vision-задачи: разбор накладной,
 * EXIF-проверка, поиск номера и даты на фото. Sonnet быстрее Opus и
 * умеет в Vision; Opus оставлен как ручной override через env.
 */
export function getVisionModel(): string {
  return process.env.ANTHROPIC_MODEL_VISION ?? DEFAULT_VISION_MODEL
}

/**
 * Action-Борис (7.16.A.2): tool-calling AI-агент для менеджеров.
 * Sonnet — баланс между качеством planning'а и скоростью; Haiku не тянет
 * multi-tool reasoning, Opus дорог для частых разговоров.
 */
export function getBorisModel(): string {
  if (getBorisProvider() === 'openai') {
    return process.env.OPENAI_MODEL_BORIS?.trim() || 'gpt-6-luna'
  }
  return process.env.ANTHROPIC_MODEL_BORIS ?? DEFAULT_BORIS_MODEL
}

/**
 * Борис-Директ (роль «трафик»): ТЯЖЁЛЫЕ суждения — спорные минусы,
 * недельный/месячный разбор, стратегия, текст владельцу. Opus: этих вызовов
 * мало, цена ошибки в деньгах рекламного бюджета высока. Арифметику
 * (цена заявки, пороги, фильтры) считает КОД, не модель.
 */
export function getBorisDirectModel(): string {
  return process.env.ANTHROPIC_MODEL_BORIS_DIRECT ?? DEFAULT_BORIS_DIRECT_MODEL
}

/**
 * Борис-Директ: ЛЁГКОЕ/рутинное (короткие формулировки, классификация
 * бесспорных случаев). Sonnet — дешевле heavy-Opus, тянет рутинную классификацию.
 */
export function getBorisDirectLightModel(): string {
  return process.env.ANTHROPIC_MODEL_BORIS_DIRECT_LIGHT ?? DEFAULT_BORIS_DIRECT_LIGHT_MODEL
}
