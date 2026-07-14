/**
 * Свободный (не-командный) ОБРАЩЁННЫЙ текст в чате «Директ от Бориса» → read-only
 * ответ РОЛЬЮ трафика (фикс 14.07, вариант 1 диагностики маршрутизации).
 *
 * Раньше нераспознанный текст в чате Директа падал в общий контур заказов
 * (getBorisSystemPrompt без домена) → «это не по моей части». Теперь домен
 * подмешивается по факту чата: getBorisDirectSystemPrompt (личность BORIS_VOICE НЕ
 * форкается — переиспользуется) + живой контекст роли.
 *
 * СТРОГО READ-ONLY: контекст собирается ЧТЕНИЕМ (статус, последний день, число
 * предложений, уроки), ответ — одна light-LLM генерация текста. Ни одного write, ни
 * одного вызова Директ API, никаких действий — только текст. Write-набор,
 * предохранители, гейты этим трактом НЕ задействованы.
 */

import { prisma } from '@/lib/db/prisma'
import { callBorisDirectLlm } from './llm'
import { getBorisDirectSystemPrompt } from './prompts'
import { getDirectRoleState } from './state'
import { getActiveLessonsReport } from './lessons'
import { MINUS_PERIOD_DAYS, PRIOR_CR_WINDOW_WORKDAYS } from './config'
import type { DailyReportData } from './brain'

interface RoleState {
  mode: 'OBSERVE' | 'LIVE'
  frozen: boolean
  autoNegativesEnabled: boolean
}

const FALLBACK =
  'Не смог собрать ответ по кампании — посмотри логи. Пока подскажу командами: «Борис, статус», «Борис, что ты понял», «Борис, почему <фраза>».'

const COMMAND_INVENTORY = `МОИ КОМАНДЫ (жёсткие; свободный текст я тоже понимаю и отвечу советом):
- «Борис, статус» — режим / стоп-кран / гейт
- «Борис, почему <фраза>» — что и почему сделал по фразе
- «Борис, сделка <телефон> <сумма>» / «… отмена» — отметить выручку сделки
- «Борис, стоп» / «Борис, продолжай» — заморозить / снять автономию
- «Борис, боевой» / «Борис, наблюдение» — режим
- «Борис, откати последнее» — откат последнего действия
- «Борис, верни гейт» — вернуть спорные минусы под подтверждение
- «Борис, что ты понял» — уроки по кампании`

const FREE_TEXT_RULES = `ФОРМАТ СВОБОДНОГО ОТВЕТА В ЧАТЕ (СТРОГО):
- Ты ТОЛЬКО объясняешь, советуешь и предлагаешь план СЛОВАМИ. НЕ обещай «сделаю / применю / запущу / уже запустил» — автономных действий из переписки ты не совершаешь: минусы и ставки идут своими путями под предохранителями, спорное — предложениями с кнопками «Да/Нет».
- Цифры бери ТОЛЬКО из блока «ЖИВОЙ КОНТЕКСТ». Выдумывать и пересчитывать числа запрещено. Нет данных для ответа — так и скажи.
- Чего в данных НЕТ — не сочиняй. Пример: разбивка трафика по MatchType (синоним/точный) ПО ЗАПРОСАМ не хранится — доступен только агрегат в недельном отчёте. Честно скажи, чего нет, что есть вместо этого (пофразная экономика: показы/клики/расход/заявки по запросам за окна) и какой командой это посмотреть.
- Коротко, по делу, голосом Бориса. Без markdown.`

function statusLine(state: RoleState): string {
  const mode = state.frozen
    ? 'стоп-кран (автономия заморожена)'
    : state.mode === 'LIVE'
      ? 'боевой'
      : 'наблюдение'
  const gate = state.autoNegativesEnabled
    ? 'снят (спорные минусы беру в автономию)'
    : 'на месте (спорные — предложениями)'
  return `Режим: ${mode}. Гейт спорных минусов: ${gate}.`
}

const windowsLine = `Окна решений: минусы — по ${MINUS_PERIOD_DAYS} рабочим дням, вердикты ставок — по ${PRIOR_CR_WINDOW_WORKDAYS}. По одному дню выводов не делаю — день это точка в окне.`

async function latestDayLine(): Promise<string> {
  try {
    const snap = await prisma.borisDirectSnapshot.findFirst({
      where: { kind: 'daily_result' },
      orderBy: [{ tickDate: 'desc' }, { createdAt: 'desc' }],
    })
    const d = snap?.payload as DailyReportData | undefined
    if (!d || !d.dateLabel) return 'Свежих дневных данных пока нет.'
    const cpl = d.costPerLeadRub == null ? '—' : `${Math.round(d.costPerLeadRub)} ₽`
    const top = (d.topQueries ?? [])
      .slice(0, 5)
      .map((q) => `«${q.query}» — ${q.clicks} кл., ${Math.round(q.costRub)} ₽, заявок ${q.conversions}`)
      .join('; ')
    return (
      `Последний день (${d.dateLabel}): расход ${Math.round(d.spendRub ?? 0)} ₽, кликов ${d.clicks ?? 0}, ` +
      `заявок из Директа ${d.leadsFromDirect}, цена заявки ${cpl}.` +
      (top ? `\nТоп-запросы за день: ${top}.` : '')
    )
  } catch {
    return 'Свежих дневных данных прочитать не удалось.'
  }
}

async function pendingLine(): Promise<string> {
  try {
    const n = await prisma.borisDirectProposal.count({ where: { status: 'PENDING' } })
    return `Предложений без ответа владельца: ${n}.`
  } catch {
    return ''
  }
}

async function lessonsLine(): Promise<string> {
  try {
    const t = await getActiveLessonsReport()
    return t?.trim() ? `Что понял по кампании:\n${t.trim()}` : ''
  } catch {
    return ''
  }
}

/** Живой read-only контекст роли для доменного ответа в чате. */
export async function buildDirectChatContext(state: RoleState): Promise<string> {
  const [day, pending, lessons] = await Promise.all([latestDayLine(), pendingLine(), lessonsLine()])
  return [statusLine(state), windowsLine, day, pending, lessons].filter(Boolean).join('\n\n')
}

/**
 * Ответ на обращённый СВОБОДНЫЙ текст в чате Директа ролью трафика. READ-ONLY.
 * Всегда возвращает текст (при сбое — честный фолбэк с командами). Ни одного write.
 */
export async function answerDirectFreeText(userText: string): Promise<string> {
  try {
    const state = (await getDirectRoleState()) as RoleState
    const context = await buildDirectChatContext(state)
    const system = [
      getBorisDirectSystemPrompt({ mode: state.mode, frozen: state.frozen }),
      FREE_TEXT_RULES,
      `ЖИВОЙ КОНТЕКСТ (только эти цифры можно называть):\n${context}`,
      COMMAND_INVENTORY,
    ].join('\n\n')
    const llm = await callBorisDirectLlm({
      purpose: 'chat_reply',
      tier: 'light',
      system,
      userText,
      maxTokens: 700,
    })
    return llm.text?.trim() || FALLBACK
  } catch (err) {
    console.error('[boris-direct/chat-reply] свободный ответ не собрался', err)
    return FALLBACK
  }
}
