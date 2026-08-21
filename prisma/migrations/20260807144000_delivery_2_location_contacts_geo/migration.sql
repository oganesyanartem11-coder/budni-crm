-- CreateEnum
CREATE TYPE "CourierAssignmentMode" AS ENUM ('IN_HOUSE', 'EXTERNAL', 'UNASSIGNED');

-- AlterTable
ALTER TABLE "ClientContact" ADD COLUMN     "isPrimaryForDelivery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "ClientLocation" ADD COLUMN     "coordinatesSource" TEXT,
ADD COLUMN     "coordinatesUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "coordinatesUpdatedById" TEXT,
ADD COLUMN     "defaultDeliveryMode" "CourierAssignmentMode",
ADD COLUMN     "deliveryInstructions" TEXT,
ADD COLUMN     "geofenceEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "geofenceRadiusM" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN     "latitude" DECIMAL(10,7),
ADD COLUMN     "longitude" DECIMAL(10,7);

-- CreateIndex
CREATE INDEX "ClientContact_clientId_locationId_sortOrder_idx" ON "ClientContact"("clientId", "locationId", "sortOrder");

-- One explicit primary delivery contact per physical location. Client-wide
-- contacts have locationId=NULL and are intentionally outside this constraint.
CREATE UNIQUE INDEX "ClientContact_locationId_primary_delivery_unique"
ON "ClientContact"("locationId")
WHERE "locationId" IS NOT NULL AND "isPrimaryForDelivery" = true;

-- CreateIndex
CREATE INDEX "ClientLocation_coordinatesUpdatedById_idx" ON "ClientLocation"("coordinatesUpdatedById");

-- AddForeignKey
ALTER TABLE "ClientContact" ADD CONSTRAINT "ClientContact_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "ClientLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientLocation" ADD CONSTRAINT "ClientLocation_coordinatesUpdatedById_fkey" FOREIGN KEY ("coordinatesUpdatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
