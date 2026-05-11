import { prisma } from '@/lib/db/prisma'
import type { InboxItemReason, InboxItemPriority, Prisma } from '@prisma/client'

export interface CreateInboxItemInput {
  clientId: string
  conversationId?: string | null
  reason: InboxItemReason
  humanReason: string
  priority: InboxItemPriority
  clientMessage?: string | null
  parsedJson?: Prisma.InputJsonValue
  clientStatsSnapshot?: Prisma.InputJsonValue
  draftReply?: string | null
}

export async function createInboxItem(input: CreateInboxItemInput) {
  return prisma.inboxItem.create({
    data: {
      clientId: input.clientId,
      conversationId: input.conversationId ?? null,
      reason: input.reason,
      humanReason: input.humanReason,
      priority: input.priority,
      status: 'OPEN',
      clientMessage: input.clientMessage ?? null,
      parsedJson: input.parsedJson ?? undefined,
      clientStatsSnapshot: input.clientStatsSnapshot ?? undefined,
      draftReply: input.draftReply ?? null,
    },
  })
}
