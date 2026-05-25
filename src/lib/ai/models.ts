/**
 * Единая точка резолва Claude-моделей для AI-вызовов.
 *
 * Зачем env vars: A/B-тесты моделей без code-change, быстрое переключение
 * в случае инцидента (например, временно деградировать parser на Sonnet).
 *
 * Дефолты совпадают с текущим production-кодом, чтобы поведение проекта
 * без выставленных env осталось прежним.
 */

const DEFAULT_PARSER_MODEL = 'claude-opus-4-7'
const DEFAULT_RECIPES_MODEL = 'claude-opus-4-7'
const DEFAULT_INBOX_MODEL = 'claude-haiku-4-5-20251001'
const DEFAULT_FALLBACK_MODEL = 'claude-sonnet-4-6'
const DEFAULT_VISION_MODEL = 'claude-sonnet-4-6'

/** parseMenuSchedule: разбор структуры меню из Excel/фото (Opus). */
export function getParserModel(): string {
  return process.env.ANTHROPIC_MODEL_PARSER ?? DEFAULT_PARSER_MODEL
}

/** generateRecipes: генерация техкарт по списку блюд (Opus). */
export function getRecipesModel(): string {
  return process.env.ANTHROPIC_MODEL_RECIPES ?? DEFAULT_RECIPES_MODEL
}

/** parseClientResponse + generateDraftReply: бот-флоу (Haiku, мелкие частые вызовы). */
export function getInboxModel(): string {
  return process.env.ANTHROPIC_MODEL_INBOX ?? DEFAULT_INBOX_MODEL
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
