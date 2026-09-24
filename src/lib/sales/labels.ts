import type {
  LandingLeadDealStatus,
  LeadLostReason,
  LeadPipelineStatus,
  SalesTaskType,
  UserRole,
} from '@prisma/client'

/**
 * Sprint 8.0 «Продажи»: словари воронки заявок (стадии, причины отказа, типы
 * задач, источники) и маппинг стадии ↔ dealStatus Бориса-Директа.
 * Чистый модуль без I/O — импортируется и сервером, и клиентскими компонентами.
 */

// ---------- Доступ ----------

/** Кому открыт раздел /sales. Расширяется одной строкой (напр. + 'MANAGER'). */
export const SALES_ROLES = ['ADMIN_PRO'] as const satisfies readonly UserRole[]

export function isSalesRole(role: UserRole): boolean {
  return (SALES_ROLES as readonly UserRole[]).includes(role)
}

// ---------- Стадии ----------

export const PIPELINE_STATUS_RU: Record<LeadPipelineStatus, string> = {
  NEW: 'Новая',
  IN_PROGRESS: 'В работе',
  PROPOSAL_SENT: 'КП отправлено',
  TRIAL: 'Пробный день',
  CONTRACT: 'Договор',
  WON: 'Клиент',
  LOST: 'Отказ',
}

/** Порядок степпера в карточке заявки (без финальных WON/LOST). */
export const PIPELINE_STEPS = [
  'NEW',
  'IN_PROGRESS',
  'PROPOSAL_SENT',
  'TRIAL',
  'CONTRACT',
] as const satisfies readonly LeadPipelineStatus[]

/** Активные (незакрытые) стадии — те же, что в степпере. */
export const ACTIVE_STATUSES: LeadPipelineStatus[] = [...PIPELINE_STEPS]

export function isActiveStatus(status: LeadPipelineStatus): boolean {
  return ACTIVE_STATUSES.includes(status)
}

/** Семантический вариант чипа — те же токены, что у StatusBadge. */
export type SalesChipVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

export const PIPELINE_STATUS_VARIANT: Record<LeadPipelineStatus, SalesChipVariant> = {
  NEW: 'info',
  IN_PROGRESS: 'neutral',
  PROPOSAL_SENT: 'warning',
  TRIAL: 'warning',
  CONTRACT: 'success',
  WON: 'success',
  LOST: 'danger',
}

// ---------- Отказ ----------

export const LOST_REASON_RU: Record<LeadLostReason, string> = {
  EXPENSIVE: 'Дорого',
  NO_ANSWER: 'Не дозвонились',
  CHOSE_OTHER: 'Выбрали других',
  FORMAT_MISMATCH: 'Не подошёл формат',
  OTHER: 'Другое',
}

// ---------- Задачи ----------

export const TASK_TYPE_RU: Record<SalesTaskType, string> = {
  CALL: 'Позвонить',
  WRITE: 'Написать',
  SEND_PROPOSAL: 'Отправить КП',
  MEETING: 'Встреча',
  TRIAL: 'Пробный день',
  OTHER: 'Другое',
}

/** Порядок типов задач в UI (чипы выбора). */
export const TASK_TYPES: SalesTaskType[] = ['CALL', 'WRITE', 'SEND_PROPOSAL', 'MEETING', 'TRIAL', 'OTHER']

// ---------- Форма / источник ----------

export const FORM_TYPE_RU: Record<string, string> = {
  popup: 'Сайт: попап',
  quiz: 'Сайт: квиз',
  phone_call: 'Звонок',
  manual: 'Вручную',
}

export function formTypeLabel(formType: string): string {
  return FORM_TYPE_RU[formType] ?? formType
}

// Человекочитаемые имена источников (data-source блоков лендинга budni.pro).
// Вынесено из /api/leads/intake без изменений: роут импортирует эту карту
// обратно и использует её как раньше (точное совпадение, иначе сырой код).
export const SOURCE_LABELS: Record<string, string> = {
  'mobile-menu': 'Меню (моб.) — Рассчитать бюджет',
  'hero-secondary': 'Hero — Заказать дегустацию',
  'aud-office': 'Попап: Офисы',
  'aud-build': 'Попап: Стройки и объекты',
  'aud-warehouse': 'Попап: Склады и производства',
  'aud-med': 'Попап: Медучреждения',
  'aud-film': 'Попап: Съёмочные группы',
  'aud-event': 'Попап: Разовые мероприятия',
  'block-8-shashlyk': 'Шашлык — Хочу шашлык в команду',
  'menu-full': 'Меню — Получить полное меню',
  'case-night': 'Кейс — Оставить заявку',
  chef: 'Шеф Иван — Заказать дегустацию',
  'tasting-block': 'Блок дегустации',
  'final-tasting': 'Финал — дегустация',
  'floating-button': 'Плавающая кнопка',
  'quiz-block-3': 'Квиз (блок 3)',
  'quiz-block-18-final': 'Квиз (финал)',
}

/** Источники заявок, заведённых вручную в CRM (форма /sales/new). */
export const MANUAL_SOURCE_OPTIONS = [
  { value: 'manual-phone', label: 'Звонок' },
  { value: 'manual-telegram', label: 'Telegram' },
  { value: 'manual-max', label: 'MAX' },
  { value: 'manual-referral', label: 'Рекомендация' },
  { value: 'manual-other', label: 'Другое' },
] as const

export type ManualSourceCode = (typeof MANUAL_SOURCE_OPTIONS)[number]['value']

export const MANUAL_SOURCE_CODES = MANUAL_SOURCE_OPTIONS.map((o) => o.value) as [
  ManualSourceCode,
  ...ManualSourceCode[],
]

// Коды не с лендинга: ручные заявки CRM + звонки, заведённые Борисом-Директ.
const EXTRA_SOURCE_LABELS: Record<string, string> = {
  ...Object.fromEntries(MANUAL_SOURCE_OPTIONS.map((o) => [o.value, o.label])),
  boris_call_intake: 'Звонок (через Бориса)',
}

// Подстраницы лендинга шлют коды с префиксом (korp-moskva, obedy-ofis-siti…).
const SOURCE_PREFIX_LABELS: Array<[prefix: string, label: string]> = [
  ['korp-', 'Корпоративное питание'],
  ['obedy-ofis-', 'Обеды в офис'],
  ['sotrudniki-', 'Питание сотрудников'],
  ['rabochih-', 'Питание рабочих'],
  ['menu-', 'Меню'],
]

/**
 * Код источника → читаемое имя. Точное совпадение важнее префикса
 * ('menu-full' → «Меню — Получить полное меню», 'menu-zima' → «Меню»).
 * Неизвестный код возвращаем как есть; пустой → null.
 */
export function sourceLabel(code: string | null | undefined): string | null {
  if (!code) return null
  const exact = SOURCE_LABELS[code] ?? EXTRA_SOURCE_LABELS[code]
  if (exact) return exact
  const byPrefix = SOURCE_PREFIX_LABELS.find(([prefix]) => code.startsWith(prefix))
  return byPrefix ? byPrefix[1] : code
}

/** Подписи ответов квиза лендинга (ключи answers как их шлёт сайт). */
export const QUIZ_ANSWER_LABELS: Record<string, string> = {
  format: 'Формат',
  employees: 'Сотрудников',
  frequency: 'Как часто',
  meals: 'Приёмы пищи',
  shashlyk: 'Шашлык',
}

// ---------- Стадия ↔ dealStatus (Борис-Директ) ----------

/** Стадия воронки → dealStatus (что видит Борис-Директ и офлайн-конверсии). */
export function pipelineToDealStatus(status: LeadPipelineStatus): LandingLeadDealStatus {
  switch (status) {
    case 'NEW':
      return 'NONE'
    case 'WON':
      return 'WON'
    case 'LOST':
      return 'LOST'
    default:
      return 'IN_PROGRESS'
  }
}

/**
 * dealStatus (записал Борис-Директ) → новая стадия воронки или null («не менять»).
 * WON/LOST — всегда; IN_PROGRESS — только из NEW (не откатываем КП/Пробный/Договор
 * в «В работе»); NONE — без изменений. Совпадение с текущей стадией → null
 * (идемпотентно: повторная синхронизация ничего не пишет).
 */
export function dealStatusToPipeline(
  dealStatus: LandingLeadDealStatus,
  current: LeadPipelineStatus
): LeadPipelineStatus | null {
  let next: LeadPipelineStatus | null = null
  if (dealStatus === 'WON') next = 'WON'
  else if (dealStatus === 'LOST') next = 'LOST'
  else if (dealStatus === 'IN_PROGRESS' && current === 'NEW') next = 'IN_PROGRESS'
  return next && next !== current ? next : null
}

// ---------- Фильтры списка /sales (?filter=) ----------

export const LEAD_FILTERS = [
  { value: 'active', label: 'Активные' },
  { value: 'new', label: 'Новые' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'proposal', label: 'КП' },
  { value: 'trial', label: 'Пробный' },
  { value: 'contract', label: 'Договор' },
  { value: 'closed', label: 'Закрытые' },
  { value: 'archive', label: 'Архив' },
] as const

export type LeadFilter = (typeof LEAD_FILTERS)[number]['value']

/** Значение ?filter= → фильтр; неизвестное/пустое → 'active'. */
export function parseLeadFilter(value: string | null | undefined): LeadFilter {
  return LEAD_FILTERS.some((f) => f.value === value) ? (value as LeadFilter) : 'active'
}

/** Подпись заявки в списках/TG: company || name || телефон. */
export function leadDisplayName(lead: { company?: string | null; name?: string | null; phone: string }): string {
  return lead.company?.trim() || lead.name?.trim() || lead.phone
}
