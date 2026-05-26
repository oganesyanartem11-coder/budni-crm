-- 7.14B-2: добавляем supplierInn (ИНН поставщика) в Invoice.
-- Опциональное поле, заполняется Vision-моделью при наличии в накладной.

ALTER TABLE "Invoice" ADD COLUMN "supplierInn" VARCHAR(20);

CREATE INDEX "Invoice_supplierInn_idx" ON "Invoice"("supplierInn");
