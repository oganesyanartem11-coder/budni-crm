-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "ourLegalEntityId" TEXT,
ADD COLUMN     "vatRate" DECIMAL(5,2);

-- CreateIndex
CREATE INDEX "Order_ourLegalEntityId_idx" ON "Order"("ourLegalEntityId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_ourLegalEntityId_fkey" FOREIGN KEY ("ourLegalEntityId") REFERENCES "OurLegalEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: для всех Order где у клиента есть defaultOurLegalEntityId — копируем
-- snapshot. Безопасно: меняет только NULL → значение. На прод-БД пробежит один раз,
-- на dev-БД (где prisma migrate dev уже применил DDL) этот же SQL выполняется через
-- отдельный db execute (или вообще ноль строк если данных нет).
UPDATE "Order" o
SET "ourLegalEntityId" = c."defaultOurLegalEntityId",
    "vatRate" = ole."vatRate"
FROM "Client" c
LEFT JOIN "OurLegalEntity" ole ON ole.id = c."defaultOurLegalEntityId"
WHERE o."clientId" = c.id
  AND o."ourLegalEntityId" IS NULL
  AND c."defaultOurLegalEntityId" IS NOT NULL;
