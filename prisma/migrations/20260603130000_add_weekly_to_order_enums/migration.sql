-- AlterEnum
ALTER TYPE "OrderType" ADD VALUE 'WEEKLY';

-- AlterEnum
ALTER TYPE "OrderSource" ADD VALUE 'WEEKLY_AUTO';

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyOrderSubmission_clientId_weekStartDate_key" ON "WeeklyOrderSubmission"("clientId", "weekStartDate");
