-- CreateEnum
CREATE TYPE "DeliveryGeoResult" AS ENUM ('ALLOWED', 'OUTSIDE_GEOFENCE', 'LOW_ACCURACY', 'STALE_POSITION', 'FUTURE_POSITION', 'INVALID_POSITION', 'POSITION_UNAVAILABLE', 'TARGET_UNAVAILABLE', 'GEOFENCE_NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "DeliveryOverrideStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "DeliveryGeoAttempt" (
    "id" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "courierNameSnapshot" TEXT NOT NULL,
    "courierLatitude" DECIMAL(10,7),
    "courierLongitude" DECIMAL(10,7),
    "accuracyM" DECIMAL(8,2),
    "targetLatitudeSnapshot" DECIMAL(10,7),
    "targetLongitudeSnapshot" DECIMAL(10,7),
    "targetRadiusMSnapshot" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "distanceM" DECIMAL(10,2),
    "result" "DeliveryGeoResult" NOT NULL,
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryGeoAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryOverrideRequest" (
    "id" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "geoAttemptId" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "courierNameSnapshot" TEXT NOT NULL,
    "comment" TEXT NOT NULL,
    "status" "DeliveryOverrideStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedById" TEXT,
    "resolvedByNameSnapshot" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryOverrideRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryGeoAttempt_stopId_createdAt_idx" ON "DeliveryGeoAttempt"("stopId", "createdAt");

-- CreateIndex
CREATE INDEX "DeliveryGeoAttempt_courierId_capturedAt_idx" ON "DeliveryGeoAttempt"("courierId", "capturedAt");

-- Raw GPS retention only scans attempts that still contain coordinates.
CREATE INDEX "DeliveryGeoAttempt_raw_retention_idx"
ON "DeliveryGeoAttempt"("capturedAt")
WHERE "purgedAt" IS NULL
  AND ("courierLatitude" IS NOT NULL OR "courierLongitude" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryGeoAttempt_stopId_requestId_key" ON "DeliveryGeoAttempt"("stopId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryOverrideRequest_geoAttemptId_key" ON "DeliveryOverrideRequest"("geoAttemptId");

-- CreateIndex
CREATE INDEX "DeliveryOverrideRequest_stopId_status_expiresAt_idx" ON "DeliveryOverrideRequest"("stopId", "status", "expiresAt");

-- Exactly one actionable manager decision per physical stop.
CREATE UNIQUE INDEX "DeliveryOverrideRequest_stopId_pending_unique"
ON "DeliveryOverrideRequest"("stopId")
WHERE "status" = 'PENDING';

-- CreateIndex
CREATE INDEX "DeliveryOverrideRequest_courierId_createdAt_idx" ON "DeliveryOverrideRequest"("courierId", "createdAt");

-- CreateIndex
CREATE INDEX "DeliveryOverrideRequest_resolvedById_idx" ON "DeliveryOverrideRequest"("resolvedById");

-- AddForeignKey
ALTER TABLE "DeliveryGeoAttempt" ADD CONSTRAINT "DeliveryGeoAttempt_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "CourierRouteStop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryGeoAttempt" ADD CONSTRAINT "DeliveryGeoAttempt_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryOverrideRequest" ADD CONSTRAINT "DeliveryOverrideRequest_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "CourierRouteStop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryOverrideRequest" ADD CONSTRAINT "DeliveryOverrideRequest_geoAttemptId_fkey" FOREIGN KEY ("geoAttemptId") REFERENCES "DeliveryGeoAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryOverrideRequest" ADD CONSTRAINT "DeliveryOverrideRequest_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryOverrideRequest" ADD CONSTRAINT "DeliveryOverrideRequest_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Database-level invariants protect every future writer, including callbacks.
ALTER TABLE "DeliveryGeoAttempt" ADD CONSTRAINT "DeliveryGeoAttempt_position_pair_check"
CHECK (("courierLatitude" IS NULL) = ("courierLongitude" IS NULL));

ALTER TABLE "DeliveryGeoAttempt" ADD CONSTRAINT "DeliveryGeoAttempt_target_pair_check"
CHECK (("targetLatitudeSnapshot" IS NULL) = ("targetLongitudeSnapshot" IS NULL));

ALTER TABLE "DeliveryGeoAttempt" ADD CONSTRAINT "DeliveryGeoAttempt_values_check"
CHECK (
  "targetRadiusMSnapshot" > 0
  AND ("accuracyM" IS NULL OR "accuracyM" >= 0)
  AND ("distanceM" IS NULL OR "distanceM" >= 0)
  AND ("courierLatitude" IS NULL OR "courierLatitude" BETWEEN -90 AND 90)
  AND ("courierLongitude" IS NULL OR "courierLongitude" BETWEEN -180 AND 180)
  AND ("targetLatitudeSnapshot" IS NULL OR "targetLatitudeSnapshot" BETWEEN -90 AND 90)
  AND ("targetLongitudeSnapshot" IS NULL OR "targetLongitudeSnapshot" BETWEEN -180 AND 180)
  AND length(btrim("requestId")) > 0
);

ALTER TABLE "DeliveryGeoAttempt" ADD CONSTRAINT "DeliveryGeoAttempt_purge_check"
CHECK (
  "purgedAt" IS NULL
  OR ("courierLatitude" IS NULL AND "courierLongitude" IS NULL)
);

ALTER TABLE "DeliveryOverrideRequest" ADD CONSTRAINT "DeliveryOverrideRequest_comment_check"
CHECK (length(btrim("comment")) > 0 AND "expiresAt" > "createdAt");

ALTER TABLE "DeliveryOverrideRequest" ADD CONSTRAINT "DeliveryOverrideRequest_resolution_check"
CHECK (
  (
    "status" = 'PENDING'
    AND "resolvedAt" IS NULL
    AND "resolvedById" IS NULL
    AND "resolvedByNameSnapshot" IS NULL
  )
  OR (
    "status" = 'EXPIRED'
    AND "resolvedAt" IS NOT NULL
    AND "resolvedById" IS NULL
    AND "resolvedByNameSnapshot" IS NULL
  )
  OR (
    "status" IN ('APPROVED', 'REJECTED')
    AND "resolvedAt" IS NOT NULL
    AND "resolvedById" IS NOT NULL
    AND "resolvedByNameSnapshot" IS NOT NULL
  )
);
