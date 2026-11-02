import { prisma } from '@/lib/db/prisma'
import type { BotMessageDirection, Prisma } from '@prisma/client'
import { maxGroupContext } from '@/lib/max/group-context'

export interface LogBotMessageInput {
  clientId: string
  conversationId?: string | null
  direction: BotMessageDirection
  text: string
  parsedJson?: Prisma.InputJsonValue
  llmConfidence?: number
  llmReason?: string
  toneLabel?: string
}

export async function logBotMessage(input: LogBotMessageInput) {
  const group = maxGroupContext.getStore()
  return prisma.botMessage.create({
    data: {
      clientId: input.clientId,
      conversationId: input.conversationId ?? null,
      direction: input.direction,
      text: group && input.direction === 'IN'
        ? `[Группа MAX · ${group.senderName} (${group.senderId})]\n${input.text}`
        : input.text,
      parsedJson: input.parsedJson ?? undefined,
      llmConfidence: input.llmConfidence ?? null,
      llmReason: input.llmReason ?? null,
      toneLabel: input.toneLabel ?? null,
    },
  })
}
