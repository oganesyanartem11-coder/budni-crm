-- CreateTable
CREATE TABLE "BorisHaikuLog" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userMessageText" TEXT NOT NULL,
    "lastBorisReply" TEXT,
    "verdict" BOOLEAN NOT NULL,
    "model" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "costUsd" DECIMAL(10,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BorisHaikuLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BorisHaikuLog_chatId_idx" ON "BorisHaikuLog"("chatId");

-- CreateIndex
CREATE INDEX "BorisHaikuLog_createdAt_idx" ON "BorisHaikuLog"("createdAt");
