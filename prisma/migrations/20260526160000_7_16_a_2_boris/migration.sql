-- AlterEnum
ALTER TYPE "OrderSource" ADD VALUE 'BORIS';

-- CreateTable
CREATE TABLE "BorisConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "BorisConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BorisMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "toolName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BorisMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BorisPendingAction" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "actions" JSONB NOT NULL,
    "previewText" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BorisPendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BorisConversation_userId_closedAt_idx" ON "BorisConversation"("userId", "closedAt");

-- CreateIndex
CREATE INDEX "BorisConversation_userId_lastMessageAt_idx" ON "BorisConversation"("userId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "BorisMessage_conversationId_createdAt_idx" ON "BorisMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "BorisPendingAction_conversationId_executedAt_cancelledAt_idx" ON "BorisPendingAction"("conversationId", "executedAt", "cancelledAt");

-- AddForeignKey
ALTER TABLE "BorisConversation" ADD CONSTRAINT "BorisConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BorisMessage" ADD CONSTRAINT "BorisMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BorisConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BorisPendingAction" ADD CONSTRAINT "BorisPendingAction_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BorisConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
