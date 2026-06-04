-- CreateEnum
CREATE TYPE "PendingOrderChangeStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED');

-- CreateEnum
CREATE TYPE "PendingOrderChangeAction" AS ENUM ('EDIT', 'CREATE');

-- AlterEnum
ALTER TYPE "OrderSource" ADD VALUE 'CLIENT_REQUEST';

-- CreateTable
CREATE TABLE "PendingOrderChange" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "deliveryDate" TIMESTAMP(3) NOT NULL,
    "mealType" "MealType" NOT NULL,
    "action" "PendingOrderChangeAction" NOT NULL,
    "proposedPortions" INTEGER NOT NULL,
    "currentOrderId" TEXT,
    "currentPortions" INTEGER,
    "sourceMaxChatId" TEXT NOT NULL,
    "rawClientMessage" TEXT NOT NULL,
    "parsedConfidence" DOUBLE PRECISION NOT NULL,
    "status" "PendingOrderChangeStatus" NOT NULL DEFAULT 'PENDING',
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingOrderChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingOrderChange_clientId_deliveryDate_idx" ON "PendingOrderChange"("clientId", "deliveryDate");

-- CreateIndex
CREATE INDEX "PendingOrderChange_status_expiresAt_idx" ON "PendingOrderChange"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "PendingOrderChange_createdAt_idx" ON "PendingOrderChange"("createdAt");

-- AddForeignKey
ALTER TABLE "PendingOrderChange" ADD CONSTRAINT "PendingOrderChange_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingOrderChange" ADD CONSTRAINT "PendingOrderChange_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "ClientLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
