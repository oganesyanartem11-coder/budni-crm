-- CreateTable
CREATE TABLE "ClientPortionBaseline" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "portions" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "ClientPortionBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingAnomalyConfirmation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "mealType" "MealType" NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "proposedPortions" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "PendingAnomalyConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientPortionBaseline_locationId_idx" ON "ClientPortionBaseline"("locationId");

-- CreateIndex
CREATE INDEX "ClientPortionBaseline_updatedById_idx" ON "ClientPortionBaseline"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "ClientPortionBaseline_clientId_locationId_key" ON "ClientPortionBaseline"("clientId", "locationId");

-- CreateIndex
CREATE INDEX "PendingAnomalyConfirmation_clientId_locationId_deliveryDate_idx" ON "PendingAnomalyConfirmation"("clientId", "locationId", "deliveryDate");

-- CreateIndex
CREATE INDEX "PendingAnomalyConfirmation_status_createdAt_idx" ON "PendingAnomalyConfirmation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PendingAnomalyConfirmation_resolvedById_idx" ON "PendingAnomalyConfirmation"("resolvedById");

-- AddForeignKey
ALTER TABLE "ClientPortionBaseline" ADD CONSTRAINT "ClientPortionBaseline_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPortionBaseline" ADD CONSTRAINT "ClientPortionBaseline_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "ClientLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPortionBaseline" ADD CONSTRAINT "ClientPortionBaseline_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingAnomalyConfirmation" ADD CONSTRAINT "PendingAnomalyConfirmation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingAnomalyConfirmation" ADD CONSTRAINT "PendingAnomalyConfirmation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "ClientLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingAnomalyConfirmation" ADD CONSTRAINT "PendingAnomalyConfirmation_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
