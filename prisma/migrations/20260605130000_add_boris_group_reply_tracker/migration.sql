-- CreateTable
CREATE TABLE "BorisGroupReplyTracker" (
    "id" TEXT NOT NULL,
    "tgChatId" TEXT NOT NULL,
    "lastReplyMessageId" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BorisGroupReplyTracker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BorisGroupReplyTracker_tgChatId_key" ON "BorisGroupReplyTracker"("tgChatId");
