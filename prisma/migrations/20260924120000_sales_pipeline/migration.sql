-- CreateEnum
CREATE TYPE "LeadPipelineStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'PROPOSAL_SENT', 'TRIAL', 'CONTRACT', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "LeadLostReason" AS ENUM ('EXPENSIVE', 'NO_ANSWER', 'CHOSE_OTHER', 'FORMAT_MISMATCH', 'OTHER');

-- CreateEnum
CREATE TYPE "SalesTaskType" AS ENUM ('CALL', 'WRITE', 'SEND_PROPOSAL', 'MEETING', 'TRIAL', 'OTHER');

-- CreateEnum
CREATE TYPE "SalesActivityKind" AS ENUM ('INCOMING', 'NOTE', 'STATUS_CHANGE', 'TASK_CREATED', 'TASK_DONE', 'TASK_RESCHEDULED', 'TASK_DELETED', 'DUPLICATE', 'WON', 'LOST', 'ARCHIVED', 'UNARCHIVED', 'CLIENT_LINKED');

-- AlterTable
ALTER TABLE "LandingLead" ADD COLUMN     "address" TEXT,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "assignedToId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "comment" TEXT,
ADD COLUMN     "company" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lostAt" TIMESTAMP(3),
ADD COLUMN     "lostComment" TEXT,
ADD COLUMN     "lostReason" "LeadLostReason",
ADD COLUMN     "pipelineStatus" "LeadPipelineStatus" NOT NULL DEFAULT 'NEW',
ADD COLUMN     "portionsHint" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "wonAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SalesTask" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "SalesTaskType" NOT NULL DEFAULT 'CALL',
    "title" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "doneAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "assigneeId" TEXT,
    "createdById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesActivity" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" "SalesActivityKind" NOT NULL,
    "text" TEXT NOT NULL,
    "meta" JSONB,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesTask_doneAt_dueAt_idx" ON "SalesTask"("doneAt", "dueAt");

-- CreateIndex
CREATE INDEX "SalesTask_leadId_doneAt_idx" ON "SalesTask"("leadId", "doneAt");

-- CreateIndex
CREATE INDEX "SalesActivity_leadId_createdAt_idx" ON "SalesActivity"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LandingLead_pipelineStatus_archivedAt_lastActivityAt_idx" ON "LandingLead"("pipelineStatus", "archivedAt", "lastActivityAt");

-- CreateIndex
CREATE INDEX "LandingLead_assignedToId_idx" ON "LandingLead"("assignedToId");

-- CreateIndex
CREATE INDEX "LandingLead_clientId_idx" ON "LandingLead"("clientId");

-- AddForeignKey
ALTER TABLE "LandingLead" ADD CONSTRAINT "LandingLead_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandingLead" ADD CONSTRAINT "LandingLead_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesTask" ADD CONSTRAINT "SalesTask_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "LandingLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesTask" ADD CONSTRAINT "SalesTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesActivity" ADD CONSTRAINT "SalesActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "LandingLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill (Sprint 8.0 «Продажи»): таблица LandingLead на проде непустая.
-- Стадия воронки выводится из существующего dealStatus (Борис-Директ);
-- старые заявки без сделки (>14 дней) уходят в архив, чтобы не засорять «Активные».
UPDATE "LandingLead" SET "lastActivityAt" = "createdAt";
UPDATE "LandingLead" SET "pipelineStatus" = 'WON', "wonAt" = COALESCE("offlineConversionSentAt", "createdAt") WHERE "dealStatus" = 'WON';
UPDATE "LandingLead" SET "pipelineStatus" = 'LOST', "lostAt" = "createdAt", "lostReason" = 'OTHER' WHERE "dealStatus" = 'LOST';
UPDATE "LandingLead" SET "pipelineStatus" = 'IN_PROGRESS' WHERE "dealStatus" = 'IN_PROGRESS';
UPDATE "LandingLead" SET "archivedAt" = NOW() WHERE "dealStatus" = 'NONE' AND "createdAt" < NOW() - INTERVAL '14 days';
