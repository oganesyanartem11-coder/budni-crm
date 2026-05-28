-- Добавляет привязку курьера к точке клиента. Курьер видит свои точки + непривязанные.
ALTER TABLE "ClientLocation" ADD COLUMN "assignedCourierId" TEXT;

ALTER TABLE "ClientLocation" ADD CONSTRAINT "ClientLocation_assignedCourierId_fkey"
  FOREIGN KEY ("assignedCourierId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ClientLocation_assignedCourierId_idx" ON "ClientLocation"("assignedCourierId");
