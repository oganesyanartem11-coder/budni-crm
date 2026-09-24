'use server'

import { revalidatePath } from 'next/cache'
import { requireRole } from '@/lib/auth/current-user'
import { SALES_ROLES } from '@/lib/sales/labels'
import {
  addLeadNoteCore,
  archiveLeadCore,
  assignLeadCore,
  changeLeadStatusCore,
  completeTaskCore,
  createLeadCore,
  createTaskCore,
  deleteTaskCore,
  linkLeadToClientCore,
  rescheduleTaskCore,
  unarchiveLeadCore,
  updateLeadFieldsCore,
} from '@/lib/sales/core'
import { getClientsForLink } from '@/lib/db/queries/sales'
import type {
  AddLeadNoteInput,
  AssignLeadInput,
  ChangeLeadStatusInput,
  ClientOption,
  CompleteTaskResult,
  CreateLeadInput,
  CreateTaskInput,
  LinkLeadToClientInput,
  RescheduleTaskInput,
  SalesActionResult,
  SalesActor,
  UpdateLeadFieldsInput,
} from '@/lib/sales/types'
import type { LeadPipelineStatus } from '@prisma/client'

/**
 * Sprint 8.0 «Продажи»: server actions воронки — тонкий web-слой.
 * requireRole(SALES_ROLES) → Core (src/lib/sales/core.ts, там Zod/ActivityLog) →
 * revalidatePath. Core-функции специально НЕ экспортируются отсюда: всё, что
 * экспортирует 'use server'-модуль, достижимо прямым POST, а Core доверяет actor.
 */

export type ActionResult<T = void> = SalesActionResult<T>

async function currentActor(): Promise<SalesActor> {
  const user = await requireRole([...SALES_ROLES])
  return { id: user.id, role: user.role }
}

function revalidateSales(leadId?: string | null): void {
  revalidatePath('/sales')
  if (leadId) revalidatePath(`/sales/${leadId}`)
}

export async function createLead(input: CreateLeadInput): Promise<ActionResult<{ id: string }>> {
  const result = await createLeadCore(await currentActor(), input)
  if (result.ok) revalidateSales(result.data.id)
  return result
}

export async function updateLeadFields(input: UpdateLeadFieldsInput): Promise<ActionResult> {
  const result = await updateLeadFieldsCore(await currentActor(), input)
  if (result.ok) revalidateSales(input.leadId)
  return result
}

export async function changeLeadStatus(
  input: ChangeLeadStatusInput
): Promise<ActionResult<{ status: LeadPipelineStatus; changed: boolean }>> {
  const result = await changeLeadStatusCore(await currentActor(), input)
  if (result.ok) revalidateSales(input.leadId)
  return result
}

export async function addLeadNote(input: AddLeadNoteInput): Promise<ActionResult> {
  const result = await addLeadNoteCore(await currentActor(), input)
  if (result.ok) revalidateSales(input.leadId)
  return result
}

export async function createTask(
  input: CreateTaskInput
): Promise<ActionResult<{ taskId: string; leadId: string; dueAt: Date; deduplicated: boolean }>> {
  const result = await createTaskCore(await currentActor(), input)
  if (result.ok) revalidateSales(input.leadId)
  return result
}

export async function completeTask(taskId: string): Promise<ActionResult<CompleteTaskResult>> {
  const result = await completeTaskCore(await currentActor(), taskId)
  if (result.ok) revalidateSales(result.data.leadId)
  return result
}

export async function rescheduleTask(
  input: RescheduleTaskInput
): Promise<ActionResult<{ leadId: string; title: string; dueAt: Date }>> {
  const result = await rescheduleTaskCore(await currentActor(), input)
  if (result.ok) revalidateSales(result.data.leadId)
  return result
}

export async function deleteTask(taskId: string): Promise<ActionResult<{ leadId: string }>> {
  const result = await deleteTaskCore(await currentActor(), taskId)
  if (result.ok) revalidateSales(result.data.leadId)
  return result
}

export async function archiveLead(leadId: string): Promise<ActionResult> {
  const result = await archiveLeadCore(await currentActor(), leadId)
  if (result.ok) revalidateSales(leadId)
  return result
}

export async function unarchiveLead(leadId: string): Promise<ActionResult> {
  const result = await unarchiveLeadCore(await currentActor(), leadId)
  if (result.ok) revalidateSales(leadId)
  return result
}

export async function linkLeadToClient(
  input: LinkLeadToClientInput
): Promise<ActionResult<{ clientId: string; clientName: string }>> {
  const result = await linkLeadToClientCore(await currentActor(), input)
  if (result.ok) {
    revalidateSales(input.leadId)
    revalidatePath(`/clients/${input.clientId}`)
  }
  return result
}

export async function assignLead(input: AssignLeadInput): Promise<ActionResult> {
  const result = await assignLeadCore(await currentActor(), input)
  if (result.ok) revalidateSales(input.leadId)
  return result
}

/** Поиск клиентов для диалога «Привязать к существующему». */
export async function searchClientsForLink(q: string): Promise<ClientOption[]> {
  await currentActor()
  return getClientsForLink(q)
}
