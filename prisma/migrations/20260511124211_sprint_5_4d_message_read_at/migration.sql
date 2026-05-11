-- Sprint 5.4d: непрочитанность переезжает на BotMessage.readAt
-- (InboxItem.status остаётся в схеме до Sprint 6 — для аудита).

-- Add nullable readAt to BotMessage
ALTER TABLE "BotMessage" ADD COLUMN "readAt" TIMESTAMP(3);

-- Index for the unread counter query: WHERE direction='IN' AND readAt IS NULL
CREATE INDEX "BotMessage_direction_readAt_idx" ON "BotMessage"("direction", "readAt");
