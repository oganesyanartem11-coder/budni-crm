/*
  Warnings:

  - Added the required column `clientId` to the `BotMessage` table without a default value. This is not possible if the table is not empty.
  - Added the required column `clientId` to the `InboxItem` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "OrderSource" ADD VALUE 'BOT';

-- DropForeignKey
ALTER TABLE "BotMessage" DROP CONSTRAINT "BotMessage_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "InboxItem" DROP CONSTRAINT "InboxItem_conversationId_fkey";

-- AlterTable
ALTER TABLE "BotMessage" ADD COLUMN     "clientId" TEXT NOT NULL,
ALTER COLUMN "conversationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "InboxItem" ADD COLUMN     "clientId" TEXT NOT NULL,
ADD COLUMN     "clientMessage" TEXT,
ADD COLUMN     "parsedJson" JSONB,
ALTER COLUMN "conversationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "sourceConversationId" TEXT;

-- CreateIndex
CREATE INDEX "BotMessage_clientId_createdAt_idx" ON "BotMessage"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "InboxItem_clientId_status_idx" ON "InboxItem"("clientId", "status");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_sourceConversationId_fkey" FOREIGN KEY ("sourceConversationId") REFERENCES "BotConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotMessage" ADD CONSTRAINT "BotMessage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotMessage" ADD CONSTRAINT "BotMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItem" ADD CONSTRAINT "InboxItem_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItem" ADD CONSTRAINT "InboxItem_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
