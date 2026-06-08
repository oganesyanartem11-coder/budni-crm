-- #4: ключевание BorisConversation по userId+chatId (изоляция личной и групповой
-- истории Бори). Аддитивно: nullable-колонка + индекс, без backfill, без
-- destructive-изменений. Старые беседы остаются с chatId=NULL (legacy).

-- AlterTable
ALTER TABLE "BorisConversation" ADD COLUMN "chatId" TEXT;

-- CreateIndex
CREATE INDEX "BorisConversation_userId_chatId_closedAt_idx" ON "BorisConversation"("userId", "chatId", "closedAt");
