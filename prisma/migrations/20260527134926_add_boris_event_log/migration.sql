-- CreateEnum
CREATE TYPE "BorisEventType" AS ENUM ('THANKS', 'FIRST_DELIVERY', 'MENU_APPROVED', 'URGENT_NEAR_DELIVERY', 'RECORD_DAY', 'COMPLAINT_FREE_WEEK', 'ANNIVERSARY', 'COURIER_ON_TIME_STREAK', 'BIG_INVOICE', 'STABLE_PRICE');

-- CreateEnum
CREATE TYPE "BorisEventChannel" AS ENUM ('LIVE', 'EVENING', 'FRIDAY', 'ALERT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BriefingType" ADD VALUE 'TEAM_LIVE';
ALTER TYPE "BriefingType" ADD VALUE 'TEAM_EVENING';
ALTER TYPE "BriefingType" ADD VALUE 'TEAM_FRIDAY';
ALTER TYPE "BriefingType" ADD VALUE 'TEAM_ALERT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BorisMetricSource" ADD VALUE 'TEAM_LIVE';
ALTER TYPE "BorisMetricSource" ADD VALUE 'TEAM_EVENING';
ALTER TYPE "BorisMetricSource" ADD VALUE 'TEAM_FRIDAY';
ALTER TYPE "BorisMetricSource" ADD VALUE 'TEAM_ALERT';

-- CreateTable
CREATE TABLE "BorisEventLog" (
    "id" TEXT NOT NULL,
    "eventType" "BorisEventType" NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "clientId" TEXT,
    "orderId" TEXT,
    "menuCycleId" TEXT,
    "payload" JSONB NOT NULL,
    "deduplKey" TEXT NOT NULL,
    "emittedTo" "BorisEventChannel",
    "emittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BorisEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BorisEventLog_deduplKey_key" ON "BorisEventLog"("deduplKey");

-- CreateIndex
CREATE INDEX "BorisEventLog_eventDate_idx" ON "BorisEventLog"("eventDate");

-- CreateIndex
CREATE INDEX "BorisEventLog_eventType_eventDate_idx" ON "BorisEventLog"("eventType", "eventDate");

-- CreateIndex
CREATE INDEX "BorisEventLog_clientId_idx" ON "BorisEventLog"("clientId");

-- AddForeignKey
ALTER TABLE "BorisEventLog" ADD CONSTRAINT "BorisEventLog_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BorisEventLog" ADD CONSTRAINT "BorisEventLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BorisEventLog" ADD CONSTRAINT "BorisEventLog_menuCycleId_fkey" FOREIGN KEY ("menuCycleId") REFERENCES "MenuCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
