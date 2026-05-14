-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "issueComment" TEXT,
ADD COLUMN     "issueReason" TEXT,
ADD COLUMN     "issueReportedAt" TIMESTAMP(3),
ADD COLUMN     "issueReportedById" TEXT;

-- CreateIndex
CREATE INDEX "Delivery_issueReportedAt_idx" ON "Delivery"("issueReportedAt");
