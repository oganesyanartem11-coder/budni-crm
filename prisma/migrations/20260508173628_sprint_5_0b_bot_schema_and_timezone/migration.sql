/*
  Warnings:

  - A unique constraint covering the columns `[maxChatId]` on the table `Client` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[maxOnboardingToken]` on the table `Client` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "BotConversationStatus" AS ENUM ('PENDING', 'AWAITING_MANAGER', 'CONFIRMED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BotMessageDirection" AS ENUM ('IN', 'OUT', 'MANAGER_OUT');

-- CreateEnum
CREATE TYPE "InboxItemReason" AS ENUM ('NEW_CLIENT', 'ANOMALY_HISTORICAL', 'ANOMALY_THRESHOLD', 'ANOMALY_LLM_CONFIDENCE', 'NON_NUMERIC', 'CANCELLATION_INTENT', 'POST_CUTOFF');

-- CreateEnum
CREATE TYPE "InboxItemPriority" AS ENUM ('NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "InboxItemStatus" AS ENUM ('OPEN', 'RESOLVED_SENT', 'RESOLVED_IGNORED');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "locationAliases" JSONB,
ADD COLUMN     "maxChatId" TEXT,
ADD COLUMN     "maxOnboardingToken" TEXT,
ADD COLUMN     "safeAnswerStreak" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BotConversation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "deliveryDate" TIMESTAMP(3) NOT NULL,
    "status" "BotConversationStatus" NOT NULL DEFAULT 'PENDING',
    "questionVariant" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "BotMessageDirection" NOT NULL,
    "text" TEXT NOT NULL,
    "parsedJson" JSONB,
    "llmConfidence" DOUBLE PRECISION,
    "llmReason" TEXT,
    "toneLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxItem" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "reason" "InboxItemReason" NOT NULL,
    "priority" "InboxItemPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "InboxItemStatus" NOT NULL DEFAULT 'OPEN',
    "humanReason" TEXT,
    "clientStatsSnapshot" JSONB,
    "draftReply" TEXT,
    "managerReply" TEXT,
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "InboxItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotConversation_deliveryDate_idx" ON "BotConversation"("deliveryDate");

-- CreateIndex
CREATE INDEX "BotConversation_status_idx" ON "BotConversation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BotConversation_clientId_deliveryDate_key" ON "BotConversation"("clientId", "deliveryDate");

-- CreateIndex
CREATE INDEX "BotMessage_conversationId_createdAt_idx" ON "BotMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "InboxItem_status_createdAt_idx" ON "InboxItem"("status", "createdAt");

-- CreateIndex
CREATE INDEX "InboxItem_priority_status_idx" ON "InboxItem"("priority", "status");

-- CreateIndex
CREATE INDEX "InboxItem_conversationId_idx" ON "InboxItem"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_maxChatId_key" ON "Client"("maxChatId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_maxOnboardingToken_key" ON "Client"("maxOnboardingToken");

-- AddForeignKey
ALTER TABLE "BotConversation" ADD CONSTRAINT "BotConversation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotMessage" ADD CONSTRAINT "BotMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItem" ADD CONSTRAINT "InboxItem_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItem" ADD CONSTRAINT "InboxItem_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
