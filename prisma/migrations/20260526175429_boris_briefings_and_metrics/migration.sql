-- Sprint 7.16.B: Boris briefings (morning + self-analysis) and BorisMetrics.
-- Pure additive: два новых enum'а, две новые таблицы, индексы, FK.
-- Никаких изменений существующих таблиц.

-- CreateEnum
CREATE TYPE "BriefingType" AS ENUM ('MORNING', 'SELF_ANALYSIS');

-- CreateEnum
CREATE TYPE "BorisMetricSource" AS ENUM ('ACTION_CHAT', 'ACTION_EXECUTOR', 'MORNING', 'SELF_ANALYSIS');

-- CreateTable
CREATE TABLE "BorisBriefing" (
    "id" TEXT NOT NULL,
    "type" "BriefingType" NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipientUserId" TEXT,
    "recipientChatId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contextData" JSONB,
    "sentToTg" BOOLEAN NOT NULL DEFAULT false,
    "tgMessageId" TEXT,
    "errorMessage" TEXT,
    "isDryRun" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BorisBriefing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BorisMetrics" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "userId" TEXT,
    "toolName" TEXT,
    "ok" BOOLEAN NOT NULL,
    "errorMessage" TEXT,
    "durationMs" INTEGER NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "source" "BorisMetricSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BorisMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BorisBriefing_type_generatedAt_idx" ON "BorisBriefing"("type", "generatedAt" DESC);

-- CreateIndex
CREATE INDEX "BorisBriefing_recipientUserId_idx" ON "BorisBriefing"("recipientUserId");

-- CreateIndex
CREATE INDEX "BorisMetrics_createdAt_idx" ON "BorisMetrics"("createdAt");

-- CreateIndex
CREATE INDEX "BorisMetrics_userId_createdAt_idx" ON "BorisMetrics"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BorisMetrics_source_createdAt_idx" ON "BorisMetrics"("source", "createdAt");

-- CreateIndex
CREATE INDEX "BorisMetrics_toolName_ok_idx" ON "BorisMetrics"("toolName", "ok");

-- AddForeignKey
ALTER TABLE "BorisBriefing" ADD CONSTRAINT "BorisBriefing_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BorisMetrics" ADD CONSTRAINT "BorisMetrics_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BorisConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BorisMetrics" ADD CONSTRAINT "BorisMetrics_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
