-- AlterTable
ALTER TABLE "PendingAnomalyConfirmation" ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "processingAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PendingAnomalyConfirmation_status_processingAt_idx" ON "PendingAnomalyConfirmation"("status", "processingAt");

-- CreateIndex
CREATE INDEX "PendingAnomalyConfirmation_conversationId_idx" ON "PendingAnomalyConfirmation"("conversationId");

-- AddForeignKey
ALTER TABLE "PendingAnomalyConfirmation" ADD CONSTRAINT "PendingAnomalyConfirmation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
