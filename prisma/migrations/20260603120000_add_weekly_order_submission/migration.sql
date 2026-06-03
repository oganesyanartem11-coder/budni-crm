-- CreateEnum
CREATE TYPE "WeeklyOrderSubmissionSource" AS ENUM ('PHOTO', 'TEXT');

-- CreateEnum
CREATE TYPE "WeeklyOrderSubmissionStatus" AS ENUM ('PARSED', 'AUTO_CONFIRMED', 'NEEDS_REVIEW', 'CANCELLED', 'FAILED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "weeklySubmissionId" TEXT;

-- CreateTable
CREATE TABLE "WeeklyOrderSubmission" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "weekStartDate" TIMESTAMP(3) NOT NULL,
    "source" "WeeklyOrderSubmissionSource" NOT NULL,
    "blobUrl" TEXT,
    "rawText" TEXT,
    "parsedJson" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" "WeeklyOrderSubmissionStatus" NOT NULL DEFAULT 'PARSED',
    "managerNotifiedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeeklyOrderSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WeeklyOrderSubmission_clientId_weekStartDate_idx" ON "WeeklyOrderSubmission"("clientId", "weekStartDate");

-- CreateIndex
CREATE INDEX "WeeklyOrderSubmission_status_idx" ON "WeeklyOrderSubmission"("status");

-- CreateIndex
CREATE INDEX "WeeklyOrderSubmission_createdAt_idx" ON "WeeklyOrderSubmission"("createdAt");

-- CreateIndex
CREATE INDEX "Order_weeklySubmissionId_idx" ON "Order"("weeklySubmissionId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_weeklySubmissionId_fkey" FOREIGN KEY ("weeklySubmissionId") REFERENCES "WeeklyOrderSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyOrderSubmission" ADD CONSTRAINT "WeeklyOrderSubmission_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
