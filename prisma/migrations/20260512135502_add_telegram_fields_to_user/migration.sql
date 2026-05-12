-- AlterTable
ALTER TABLE "User" ADD COLUMN     "telegramChatId" TEXT,
ADD COLUMN     "telegramOnboardingExpiresAt" TIMESTAMP(3),
ADD COLUMN     "telegramOnboardingToken" TEXT,
ADD COLUMN     "telegramUsername" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramChatId_key" ON "User"("telegramChatId");

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramOnboardingToken_key" ON "User"("telegramOnboardingToken");
