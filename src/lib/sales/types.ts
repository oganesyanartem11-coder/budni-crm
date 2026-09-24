import type {
  LandingLeadDealStatus,
  LeadLostReason,
  LeadPipelineStatus,
  SalesActivityKind,
  SalesTaskType,
  UserRole,
} from '@prisma/client'

/**
 * Sprint 8.0 «Продажи»: общий контракт ядра воронки (core/queries) ↔ UI ↔ TG.
 * DTO — только сериализуемые поля (Date ок для RSC; Decimal → number).
 */

// ---------- Результат мутаций ----------

/** ActionResult воронки: как в проекте + duplicateLeadId для дубля по телефону. */
export type SalesActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; duplicateLeadId?: string }

/** Кто действует (из requireRole в web или identifyTelegramUser в TG). */
export interface SalesActor {
  id: string
  role: UserRole
}

// ---------- Входы мутаций ----------

export interface CreateLeadInput {
  name: string
  phone: string
  company?: string | null
  email?: string | null
  portionsHint?: number | null
  address?: string | null
  comment?: string | null
  /** 'manual-phone' | 'manual-telegram' | 'manual-max' | 'manual-referral' | 'manual-other' */
  sourceCode: string
}

/** Частичное обновление: undefined — не трогать, null/'' — очистить. */
export interface UpdateLeadFieldsInput {
  leadId: string
  name?: string | null
  phone?: string | null
  company?: string | null
  email?: string | null
  portionsHint?: number | null
  address?: string | null
  comment?: string | null
  /** Ориентир выручки, ₽/мес (диалог «Стал клиентом» до перехода на /clients/new). */
  dealAmount?: number | null
}

export interface ChangeLeadStatusInput {
  leadId: string
  status: LeadPipelineStatus
  /** Обязателен для LOST. */
  lostReason?: LeadLostReason | null
  lostComment?: string | null
  /** Для WON: выручка ₽/мес (необязательно). */
  dealAmount?: number | null
}

export interface AddLeadNoteInput {
  leadId: string
  text: string
}

export interface CreateTaskInput {
  leadId: string
  type: SalesTaskType
  /** По умолчанию TASK_TYPE_RU[type]. */
  title?: string | null
  dueAt: Date | string
  note?: string | null
}

export interface RescheduleTaskInput {
  taskId: string
  dueAt: Date | string
}

export interface LinkLeadToClientInput {
  leadId: string
  clientId: string
}

export interface AssignLeadInput {
  leadId: string
  userId: string | null
}

// ---------- Результаты мутаций ----------

export interface CompleteTaskResult {
  leadId: string
  /** Подпись заявки: company || name || телефон. */
  leadLabel: string
  task: { id: string; type: SalesTaskType; title: string }
  /** true — задача уже была выполнена раньше, ничего не меняли. */
  alreadyDone: boolean
  hasOtherOpenTasks: boolean
  otherOpenTasksCount: number
  /** Куда логично сдвинуть стадию (только вперёд по степперу), иначе null. */
  suggestedStatus: LeadPipelineStatus | null
}

// ---------- DTO чтения ----------

export interface LeadTaskItem {
  id: string
  type: SalesTaskType
  title: string
  dueAt: Date
  note: string | null
  assigneeId: string | null
}

export interface LeadListItem {
  id: string
  name: string | null
  company: string | null
  phone: string
  formType: string
  source: string | null
  pipelineStatus: LeadPipelineStatus
  lastActivityAt: Date
  createdAt: Date
  archivedAt: Date | null
  /** Ближайшая открытая задача или null («нет следующего шага»). */
  nextTask: LeadTaskItem | null
}

export interface SalesTodayTask extends LeadTaskItem {
  lead: { id: string; name: string | null; company: string | null; phone: string }
}

export interface SalesTodayLead {
  id: string
  name: string | null
  company: string | null
  phone: string
  pipelineStatus: LeadPipelineStatus
  lastActivityAt: Date
}

export interface SalesToday {
  overdue: SalesTodayTask[]
  today: SalesTodayTask[]
  noNextStep: SalesTodayLead[]
  counts: { overdue: number; today: number; noNextStep: number }
}

export interface LeadActivityItem {
  id: string
  kind: SalesActivityKind
  text: string
  meta: Record<string, unknown> | null
  authorId: string | null
  createdAt: Date
}

export interface LeadDetail {
  id: string
  formType: string
  name: string | null
  phone: string
  phoneDigits: string | null
  source: string | null
  company: string | null
  email: string | null
  portionsHint: number | null
  address: string | null
  comment: string | null
  /** Ответы квиза как прислал сайт (объект) или null. */
  answers: Record<string, unknown> | null
  utmSource: string | null
  utmCampaign: string | null
  utmTerm: string | null
  pipelineStatus: LeadPipelineStatus
  dealStatus: LandingLeadDealStatus
  /** ₽ (Decimal → number). */
  dealAmount: number | null
  lostReason: LeadLostReason | null
  lostComment: string | null
  wonAt: Date | null
  lostAt: Date | null
  archivedAt: Date | null
  lastActivityAt: Date
  createdAt: Date
  client: { id: string; name: string } | null
  assignedTo: { id: string; name: string } | null
  /** Открытые задачи, по dueAt asc. */
  openTasks: LeadTaskItem[]
  /** Последние 150 событий, новые сверху. */
  activities: LeadActivityItem[]
}

export interface ClientOption {
  id: string
  name: string
}

export interface SalesAssignee {
  id: string
  name: string
  role: UserRole
}

/** Минимум заявки для предзаполнения /clients/new?leadId=. */
export interface LeadPrefill {
  id: string
  name: string | null
  company: string | null
  phone: string
}
