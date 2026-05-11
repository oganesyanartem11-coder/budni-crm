/*
  Warnings:

  - A unique constraint covering the columns `[maxChatId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[maxOnboardingToken]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "InboxItem" ADD COLUMN     "lastPushedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "maxChatId" TEXT,
ADD COLUMN     "maxOnboardingToken" TEXT,
ADD COLUMN     "onboardedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_maxChatId_key" ON "User"("maxChatId");

-- CreateIndex
CREATE UNIQUE INDEX "User_maxOnboardingToken_key" ON "User"("maxOnboardingToken");
