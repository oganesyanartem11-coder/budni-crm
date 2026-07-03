-- CreateEnum
CREATE TYPE "LandingLeadDealStatus" AS ENUM ('NONE', 'IN_PROGRESS', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "BorisDirectMode" AS ENUM ('OBSERVE', 'LIVE');

-- CreateEnum
CREATE TYPE "BorisDirectReportStatus" AS ENUM ('PENDING', 'READY', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "BorisDirectProposalStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BorisDirectLessonStatus" AS ENUM ('ACTIVE', 'STALE', 'REFUTED');

-- CreateTable
CREATE TABLE "LandingLead" (
    "id" TEXT NOT NULL,
    "formType" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT NOT NULL,
    "phoneDigits" TEXT,
    "source" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "yclid" TEXT,
    "gclid" TEXT,
    "pageUrl" TEXT,
    "pageReferrer" TEXT,
    "answers" JSONB,
    "meta" JSONB,
    "dealStatus" "LandingLeadDealStatus" NOT NULL DEFAULT 'NONE',
    "dealAmount" DECIMAL(12,2),
    "offlineConversionSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LandingLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BorisDirectState" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT 'main',
    "mode" "BorisDirectMode" NOT NULL DEFAULT 'OBSERVE',
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "autoNegativesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "modeChangedAt" TIMESTAMP(3),
    "frozenChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BorisDirectState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BorisDirectReportJob" (
    "id" TEXT NOT NULL,
    "reportName" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "dateFrom" TEXT NOT NULL,
    "dateTo" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" "BorisDirectReportStatus" NOT NULL DEFAULT 'PENDING',
    "tsv" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "BorisDirectReportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BorisDirectSnapshot" (
    "id" TEXT NOT NULL,
    "tickDate" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BorisDirectSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BorisDirectProposal" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "topicKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "argument" TEXT NOT NULL,
    "question" TEXT,
    "status" "BorisDirectProposalStatus" NOT NULL DEFAULT 'PENDING',
    "triggerMetric" TEXT,
    "triggerValue" DECIMAL(14,4),
    "cooldownUntil" TIMESTAMP(3),
    "tgMessageId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "outcomeVerdict" TEXT,
    "outcomeMeasuredAt" TIMESTAMP(3),
    "outcomeData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BorisDirectProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BorisDirectMinusVerdict" (
    "id" TEXT NOT NULL,
    "candidate" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ownerDecision" TEXT,
    "matched" BOOLEAN,
    "proposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "BorisDirectMinusVerdict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BorisDirectActionLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT NOT NULL,
    "mode" "BorisDirectMode" NOT NULL,
    "applied" BOOLEAN NOT NULL,
    "revertedAt" TIMESTAMP(3),
    "revertOfId" TEXT,
    "outcomeVerdict" TEXT,
    "outcomeMeasuredAt" TIMESTAMP(3),
    "outcomeData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BorisDirectActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BorisDirectLlmLog" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadInputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BorisDirectLlmLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BorisDirectQueryDailyStat" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "query" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "adGroupName" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "costRub" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BorisDirectQueryDailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BorisDirectLesson" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT,
    "text" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "status" "BorisDirectLessonStatus" NOT NULL DEFAULT 'ACTIVE',
    "weeksConfirmed" INTEGER NOT NULL DEFAULT 0,
    "lastConfirmedAt" TIMESTAMP(3),
    "refutedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BorisDirectLesson_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LandingLead_createdAt_idx" ON "LandingLead"("createdAt");

-- CreateIndex
CREATE INDEX "LandingLead_yclid_idx" ON "LandingLead"("yclid");

-- CreateIndex
CREATE INDEX "LandingLead_phoneDigits_idx" ON "LandingLead"("phoneDigits");

-- CreateIndex
CREATE UNIQUE INDEX "BorisDirectState_key_key" ON "BorisDirectState"("key");

-- CreateIndex
CREATE UNIQUE INDEX "BorisDirectReportJob_reportName_key" ON "BorisDirectReportJob"("reportName");

-- CreateIndex
CREATE INDEX "BorisDirectReportJob_status_requestedAt_idx" ON "BorisDirectReportJob"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "BorisDirectSnapshot_tickDate_kind_idx" ON "BorisDirectSnapshot"("tickDate", "kind");

-- CreateIndex
CREATE INDEX "BorisDirectSnapshot_kind_createdAt_idx" ON "BorisDirectSnapshot"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "BorisDirectProposal_status_createdAt_idx" ON "BorisDirectProposal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BorisDirectProposal_topicKey_cooldownUntil_idx" ON "BorisDirectProposal"("topicKey", "cooldownUntil");

-- CreateIndex
CREATE INDEX "BorisDirectMinusVerdict_createdAt_idx" ON "BorisDirectMinusVerdict"("createdAt");

-- CreateIndex
CREATE INDEX "BorisDirectMinusVerdict_matched_decidedAt_idx" ON "BorisDirectMinusVerdict"("matched", "decidedAt");

-- CreateIndex
CREATE INDEX "BorisDirectActionLog_createdAt_idx" ON "BorisDirectActionLog"("createdAt");

-- CreateIndex
CREATE INDEX "BorisDirectActionLog_action_createdAt_idx" ON "BorisDirectActionLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "BorisDirectActionLog_applied_revertedAt_idx" ON "BorisDirectActionLog"("applied", "revertedAt");

-- CreateIndex
CREATE INDEX "BorisDirectActionLog_applied_outcomeMeasuredAt_idx" ON "BorisDirectActionLog"("applied", "outcomeMeasuredAt");

-- CreateIndex
CREATE INDEX "BorisDirectLlmLog_createdAt_idx" ON "BorisDirectLlmLog"("createdAt");

-- CreateIndex
CREATE INDEX "BorisDirectLlmLog_purpose_createdAt_idx" ON "BorisDirectLlmLog"("purpose", "createdAt");

-- CreateIndex
CREATE INDEX "BorisDirectQueryDailyStat_adGroupId_date_idx" ON "BorisDirectQueryDailyStat"("adGroupId", "date");

-- CreateIndex
CREATE INDEX "BorisDirectQueryDailyStat_date_idx" ON "BorisDirectQueryDailyStat"("date");

-- CreateIndex
CREATE UNIQUE INDEX "BorisDirectQueryDailyStat_date_query_adGroupId_key" ON "BorisDirectQueryDailyStat"("date", "query", "adGroupId");

-- CreateIndex
CREATE INDEX "BorisDirectLesson_status_kind_idx" ON "BorisDirectLesson"("status", "kind");

-- CreateIndex
CREATE INDEX "BorisDirectLesson_subjectType_subjectId_idx" ON "BorisDirectLesson"("subjectType", "subjectId");

