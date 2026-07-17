/**
 * АНАЛИТИК-ПРОХОД (рассуждающий контур, спринт 14.07). Раз в день ПОСЛЕ process
 * heavy-модель в роли «старшего аналитика кампании» получает компактный дашборд и
 * СТАВИТ 0–3 ВОПРОСА дня (не классификацию!) с каузальной цепочкой, назначая каждому
 * проверку из БЕЛОГО СПИСКА. Следующий тик проверки исполняет (analyst-checks).
 *
 * Заземление жёсткое: числа берём только из дашборда; каждый драфт валидируется
 * (analyst-ground) — выдумал число ⇒ дроп. Проверка вне белого списка ⇒ дроп.
 * Обещаний действий нет: аналитик только СПРАШИВАЕТ и назначает read-only проверку.
 *
 * Чистые: prompt/parse/filter (TDD). Оркестрация LLM — runAnalystPass (fail-safe: любой
 * сбой/пусто ⇒ пустой результат, крон не рвётся).
 */

import { callBorisDirectLlm } from './llm'
import { getBorisDirectSystemPrompt } from './prompts'
import { getDirectRoleState } from './state'
import { validateGrounding } from './analyst-ground'
import { CHECK_KEYS, isWhitelistedCheck } from './analyst-checks'
import type { AnalystCheckSpec } from './questions'
import { ANALYST_MAX_QUESTIONS } from './config'

/** Подсказка максимума вопросов (в промпт и в фильтр). */
export const ANALYST_MAX_QUESTIONS_HINT = ANALYST_MAX_QUESTIONS

export interface AnalystDraft {
  topicKey: string
  /** Вопрос с каузальной цепочкой (что изменилось → что объясняет → как проверить → что предложу). */
  question: string
  /** Человеко-текст проверки (для памяти вопросов). */
  check: string
  /** Машинная проверка из белого списка. */
  checkSpec: AnalystCheckSpec
}

// ---------- Промпт ----------

const CHECK_MENU = [
  '- metrika_goal_series {windowDays} — серия достижений цели Метрики по дням (ловит нулевую серию заявок).',
  '- compare_query_windows {windowDays, metric: clicks|costRub|conversions|cpl, querySubstr?, adGroupId?} — сравнить метрику в двух соседних окнах.',
  '- ladder_medians {windowDays} — дрейф медианы цены входа и доли ниже входа за окно.',
  '- cohort_economics {criterionIds:[...], raiseDay, windowDays} — цена заявки когорты фраз до/после дня.',
  '- device_geo_slice {dimension: device|geo, windowDays} — срез визитов/заявок по устройству или гео.',
].join('\n')

export const ANALYST_INSTRUCTION =
  'Ты — СТАРШИЙ АНАЛИТИК кампании Бориса. Твоя задача — не классифицировать, а ЗАДАВАТЬ ВОПРОСЫ. ' +
  `По дашборду ниже поставь от 0 до ${ANALYST_MAX_QUESTIONS} самых важных ВОПРОСОВ дня. Молчание (пустой ` +
  'массив) — нормальный ответ, если всё спокойно. Для каждого вопроса построй каузальную цепочку: ' +
  'ЧТО ИЗМЕНИЛОСЬ → ЧТО ЭТО МОЖЕТ ОБЪЯСНЯТЬ → КАК ДЁШЕВО ПРОВЕРИТЬ → ЧТО ПРЕДЛОЖУ владельцу, если ' +
  'подтвердится. Назначь КАЖДОМУ вопросу ровно одну проверку ИЗ БЕЛОГО СПИСКА (иначе вопрос будет ' +
  'отброшен):\n' +
  CHECK_MENU +
  '\n\nЖЁСТКИЕ ПРАВИЛА: (1) любое число в вопросе бери ТОЛЬКО из дашборда — НЕ выдумывай и не ' +
  'пересчитывай (вопрос с выдуманным числом отбрасывается); (2) ты ничего НЕ применяешь, в кабинет НЕ ' +
  'пишешь — только спрашиваешь и назначаешь read-only проверку; (3) не повторяй темы, уже висящие в ' +
  '«ВОПРОСЫ прошлых дней»; (4) строка ЗВОНКИ в дашборде — это лиды БЕЗ рекламной разметки (ручной приём ' +
  'по телефону): НЕ приписывай звонки конкретным фразам и НЕ считай их в цене заявки (CPA). Но ноль ' +
  'заявок по ФОРМЕ при наличии звонков ≠ отсутствие лидов: если форма молчит, а звонки идут — поставь ' +
  'вопрос ПОЧЕМУ лиды идут звонками, а не формой (проверить форму/цель), и НЕ режь конвертящие фразы. ' +
  'Верни СТРОГО JSON-массив без пояснений, каждый элемент: ' +
  '{"topicKey":"короткий_снейк","question":"вопрос с цепочкой","check":"что проверить словами",' +
  '"checkKey":"ключ_из_списка","checkParams":{...}}.'

/** Собрать userText для heavy-вызова: инструкция + дашборд. */
export function buildAnalystUserText(dashboardText: string): string {
  return `${ANALYST_INSTRUCTION}\n\n=== ДАШБОРД ===\n${dashboardText}`
}

// ---------- Парсинг ----------

interface RawItem {
  topicKey?: unknown
  question?: unknown
  check?: unknown
  checkKey?: unknown
  checkParams?: unknown
}

/** Снять markdown-ограждение ```json ... ``` (если есть). */
function stripFences(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return fenced ? fenced[1].trim() : raw.trim()
}

/** Достать массив элементов из ответа модели (массив | {questions:[...]}), терпимо. */
function extractArray(raw: string): RawItem[] {
  const body = stripFences(raw)
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return undefined
    }
  }
  let parsed = tryParse(body)
  if (parsed === undefined) {
    // Последняя попытка — вырезать первый [...] блок.
    const m = body.match(/\[[\s\S]*\]/)
    if (m) parsed = tryParse(m[0])
  }
  if (Array.isArray(parsed)) return parsed as RawItem[]
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { questions?: unknown }).questions)) {
    return (parsed as { questions: RawItem[] }).questions
  }
  return []
}

/**
 * Разобрать ответ аналитика в драфты. Терпимо к обёрткам/фенсам/мусору (мусор → []).
 * Элемент без question или без checkKey пропускается (нечего исполнять).
 */
export function parseAnalystOutput(raw: string): AnalystDraft[] {
  if (!raw || !raw.trim()) return []
  const items = extractArray(raw)
  const out: AnalystDraft[] = []
  for (const it of items) {
    const question = typeof it.question === 'string' ? it.question.trim() : ''
    const checkKey = typeof it.checkKey === 'string' ? it.checkKey.trim() : ''
    if (!question || !checkKey) continue
    const params =
      it.checkParams && typeof it.checkParams === 'object' && !Array.isArray(it.checkParams)
        ? (it.checkParams as Record<string, unknown>)
        : {}
    out.push({
      topicKey: typeof it.topicKey === 'string' && it.topicKey.trim() ? it.topicKey.trim() : checkKey,
      question,
      check: typeof it.check === 'string' ? it.check.trim() : '',
      checkSpec: { key: checkKey, params },
    })
  }
  return out
}

// ---------- Фильтр заземления + белого списка ----------

export interface DroppedDraft {
  draft: AnalystDraft
  reason: 'check_not_whitelisted' | 'ungrounded'
  detail: string
}

export interface FilterResult {
  kept: AnalystDraft[]
  dropped: DroppedDraft[]
}

/**
 * Отсеять драфты: (1) проверка не из белого списка; (2) число не заземлено в
 * дашборде. Оставшиеся — до maxQuestions. Заземляем текст вопроса+проверки.
 */
export function filterAnalystDrafts(drafts: AnalystDraft[], dashboardText: string, maxQuestions: number): FilterResult {
  const kept: AnalystDraft[] = []
  const dropped: DroppedDraft[] = []
  for (const d of drafts) {
    if (!isWhitelistedCheck(d.checkSpec.key)) {
      dropped.push({ draft: d, reason: 'check_not_whitelisted', detail: `ключ «${d.checkSpec.key}» не в белом списке` })
      continue
    }
    // Заземляем текст вопроса+проверки против дашборда И собственных checkParams
    // драфта (windowDays/metric и пр. — самодекларированные параметры проверки, не
    // фактические утверждения о данных: «сравню за 14 дней» не должно дропаться).
    const paramNums = JSON.stringify(d.checkSpec.params ?? {})
    const g = validateGrounding(`${d.question} ${d.check}`, `${dashboardText} ${paramNums}`)
    if (!g.grounded) {
      dropped.push({ draft: d, reason: 'ungrounded', detail: `не заземлены числа: ${g.ungrounded.join(', ')}` })
      continue
    }
    if (kept.length < maxQuestions) kept.push(d)
  }
  return { kept, dropped }
}

// ---------- Оркестрация heavy-вызова ----------

export interface AnalystPassResult {
  kept: AnalystDraft[]
  dropped: DroppedDraft[]
  raw: string
  costUsd: number
  ok: boolean
}

/**
 * Один heavy-вызов аналитика по готовому дашборду. Fail-safe: LLM упал/пусто →
 * ok=false, пустые списки (крон живёт). Числа/проверки валидируются ДО возврата.
 */
export async function runAnalystPass(dashboardText: string): Promise<AnalystPassResult> {
  try {
    const state = await getDirectRoleState()
    const system = getBorisDirectSystemPrompt({ mode: state.mode, frozen: state.frozen })
    const result = await callBorisDirectLlm({
      purpose: 'analyst_daily',
      tier: 'heavy',
      system,
      userText: buildAnalystUserText(dashboardText),
      maxTokens: 1500,
    })
    const drafts = parseAnalystOutput(result.text)
    const { kept, dropped } = filterAnalystDrafts(drafts, dashboardText, ANALYST_MAX_QUESTIONS)
    return { kept, dropped, raw: result.text, costUsd: result.costUsd, ok: true }
  } catch (err) {
    console.error('[boris-direct/analyst] heavy-вызов аналитика упал — вопросов дня не будет', err)
    return { kept: [], dropped: [], raw: '', costUsd: 0, ok: false }
  }
}

// CHECK_KEYS реэкспортируем для промпт-меню/тестов (единый источник ключей).
export { CHECK_KEYS }
