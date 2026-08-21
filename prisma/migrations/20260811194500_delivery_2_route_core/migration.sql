-- CreateEnum
CREATE TYPE "CourierAssignmentSource" AS ENUM ('LOCATION_DEFAULT', 'MANAGER');

-- CreateEnum
CREATE TYPE "CourierStopCompletionMethod" AS ENUM ('GEOFENCE', 'COURIER_DIRECT', 'MANAGER_DIRECT', 'MANAGER_OVERRIDE');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "routeStopId" TEXT;

-- CreateTable
CREATE TABLE "CourierRouteDay" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "courierNameSnapshot" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "routeChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierRouteDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourierRouteStop" (
    "id" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "clientId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "routeDayId" TEXT,
    "assignmentMode" "CourierAssignmentMode" NOT NULL,
    "assignmentSource" "CourierAssignmentSource" NOT NULL,
    "clientNameSnapshot" TEXT NOT NULL,
    "locationNameSnapshot" TEXT NOT NULL,
    "locationAddressSnapshot" TEXT NOT NULL,
    "contactNameSnapshot" TEXT,
    "contactPhoneSnapshot" TEXT,
    "contactNotesSnapshot" TEXT,
    "deliveryWindowFromSnapshot" TEXT,
    "deliveryWindowToSnapshot" TEXT,
    "deliveryInstructionsSnapshot" TEXT,
    "latitudeSnapshot" DECIMAL(10,7),
    "longitudeSnapshot" DECIMAL(10,7),
    "geofenceRadiusMSnapshot" INTEGER NOT NULL DEFAULT 1000,
    "geofenceEnabledSnapshot" BOOLEAN NOT NULL DEFAULT false,
    "assignedAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "completionMethod" "CourierStopCompletionMethod",
    "cancelledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "lateAlertClaimedAt" TIMESTAMP(3),
    "lateAlertSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierRouteStop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourierRouteDay_deliveryDate_startedAt_idx" ON "CourierRouteDay"("deliveryDate", "startedAt");

-- CreateIndex
CREATE INDEX "CourierRouteDay_deliveryDate_completedAt_idx" ON "CourierRouteDay"("deliveryDate", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CourierRouteDay_courierId_deliveryDate_key" ON "CourierRouteDay"("courierId", "deliveryDate");

-- CreateIndex
CREATE INDEX "CourierRouteStop_routeDayId_deliveredAt_cancelledAt_idx" ON "CourierRouteStop"("routeDayId", "deliveredAt", "cancelledAt");

-- CreateIndex
CREATE INDEX "CourierRouteStop_deliveryDate_deliveredAt_cancelledAt_idx" ON "CourierRouteStop"("deliveryDate", "deliveredAt", "cancelledAt");

-- CreateIndex
CREATE INDEX "CourierRouteStop_deliveryDate_assignmentMode_cancelledAt_idx" ON "CourierRouteStop"("deliveryDate", "assignmentMode", "cancelledAt");

-- CreateIndex
CREATE INDEX "CourierRouteStop_clientId_idx" ON "CourierRouteStop"("clientId");

-- CreateIndex
CREATE INDEX "CourierRouteStop_locationId_idx" ON "CourierRouteStop"("locationId");

-- CreateIndex
CREATE INDEX "CourierRouteStop_deliveryDate_lateAlertSentAt_lateAlertClaimedAt_idx" ON "CourierRouteStop"("deliveryDate", "lateAlertSentAt", "lateAlertClaimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CourierRouteStop_deliveryDate_clientId_locationId_key" ON "CourierRouteStop"("deliveryDate", "clientId", "locationId");

-- CreateIndex
CREATE INDEX "Order_routeStopId_idx" ON "Order"("routeStopId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_routeStopId_fkey" FOREIGN KEY ("routeStopId") REFERENCES "CourierRouteStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierRouteDay" ADD CONSTRAINT "CourierRouteDay_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierRouteStop" ADD CONSTRAINT "CourierRouteStop_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierRouteStop" ADD CONSTRAINT "CourierRouteStop_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "ClientLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierRouteStop" ADD CONSTRAINT "CourierRouteStop_routeDayId_fkey" FOREIGN KEY ("routeDayId") REFERENCES "CourierRouteDay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Delivery 2.0 invariants. These checks are additive and protect every writer,
-- including future cron/callback paths, from creating contradictory state.
ALTER TABLE "CourierRouteStop" ADD CONSTRAINT "CourierRouteStop_assignment_consistency_check"
CHECK (
  ("assignmentMode" = 'IN_HOUSE' AND "routeDayId" IS NOT NULL)
  OR ("assignmentMode" IN ('EXTERNAL', 'UNASSIGNED') AND "routeDayId" IS NULL)
);

ALTER TABLE "CourierRouteStop" ADD CONSTRAINT "CourierRouteStop_completion_consistency_check"
CHECK (("deliveredAt" IS NULL) = ("completionMethod" IS NULL));

ALTER TABLE "CourierRouteStop" ADD CONSTRAINT "CourierRouteStop_terminal_state_check"
CHECK (NOT ("deliveredAt" IS NOT NULL AND "cancelledAt" IS NOT NULL));
