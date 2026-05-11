import { prisma } from '@/lib/db/prisma'
import type { BotMessageDirection, Prisma } from '@prisma/client'

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
  return prisma.botMessage.create({
    data: {
      clientId: input.clientId,
      conversationId: input.conversationId ?? null,
      direction: input.direction,
      text: input.text,
      parsedJson: input.parsedJson ?? undefined,
      llmConfidence: input.llmConfidence ?? null,
      llmReason: input.llmReason ?? null,
      toneLabel: input.toneLabel ?? null,
    },
  })
}
