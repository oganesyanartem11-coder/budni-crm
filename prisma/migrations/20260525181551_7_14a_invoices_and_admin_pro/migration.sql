-- 7.14A: приёмка накладных с Vision-распознаванием + роль ADMIN_PRO.
-- Накладные грузит ADMIN_PRO, Vision-парсер раскладывает на InvoiceLine,
-- matcher ищет существующие Ingredient или создаёт DRAFT-кандидатов,
-- ADMIN_PRO ревьюит и принимает (ACCEPTED) → обновляются цены и история.
-- Бизнес-ключ Invoice — (supplierNameLower, invoiceNumber, invoiceDate),
-- защищает от двойной загрузки одной и той же бумажки.

-- AlterEnum: добавляем роль ADMIN_PRO. PostgreSQL требует, чтобы новое
-- значение enum не использовалось в той же транзакции — здесь это
-- безопасно, потому что в миграции мы не INSERT/UPDATE с ADMIN_PRO.
ALTER TYPE "UserRole" ADD VALUE 'ADMIN_PRO';

-- CreateEnum
CREATE TYPE "IngredientStatus" AS ENUM ('DRAFT', 'APPROVED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PROCESSING', 'AWAITING_ACCEPT', 'ACCEPTED', 'REJECTED', 'REVERTED', 'FAILED');

-- CreateEnum
CREATE TYPE "InvoiceProgress" AS ENUM ('UPLOADED', 'RECOGNIZING', 'MATCHING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "InvoiceMatchAction" AS ENUM ('MATCHED_EXISTING', 'CREATED_NEW', 'SKIPPED');

-- CreateEnum
CREATE TYPE "InvoiceConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "PriceChangeLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'NEW');

-- AlterTable: новые поля на Ingredient. Дефолт status=APPROVED, чтобы
-- существующие 200+ ингредиентов не пропали из выпадашек шефа.
ALTER TABLE "Ingredient"
  ADD COLUMN "status"        "IngredientStatus" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "isVegetable"   BOOLEAN            NOT NULL DEFAULT false,
  ADD COLUMN "brandVariants" JSONB;

-- CreateTable
CREATE TABLE "Invoice" (
    "id"                TEXT NOT NULL,
    "supplierName"      TEXT NOT NULL,
    "supplierNameLower" TEXT NOT NULL,
    "invoiceNumber"     TEXT NOT NULL,
    "invoiceDate"       TIMESTAMP(3) NOT NULL,
    "receivedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById"      TEXT NOT NULL,
    "acceptedById"      TEXT,
    "acceptedAt"        TIMESTAMP(3),
    "revertedById"      TEXT,
    "revertedAt"        TIMESTAMP(3),
    "imageUrl"          TEXT NOT NULL,
    "imageWidth"        INTEGER,
    "imageHeight"       INTEGER,
    "exifTakenAt"       TIMESTAMP(3),
    "exifSuspicious"    BOOLEAN NOT NULL DEFAULT false,
    "status"            "InvoiceStatus" NOT NULL,
    "progress"          "InvoiceProgress" NOT NULL,
    "aiRawResponse"     JSONB,
    "aiErrorMessage"    TEXT,
    "totalAmount"       DECIMAL(10,2),
    "alertLevelSent"    "PriceChangeLevel",

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id"                   TEXT NOT NULL,
    "invoiceId"            TEXT NOT NULL,
    "lineIndex"            INTEGER NOT NULL,
    "rawName"              TEXT NOT NULL,
    "rawQuantity"          DECIMAL(10,3) NOT NULL,
    "rawUnit"              TEXT NOT NULL,
    "rawPricePerUnit"      DECIMAL(10,2) NOT NULL,
    "rawAmount"            DECIMAL(10,2) NOT NULL,
    "matchedIngredientId"  TEXT,
    "matchedAction"        "InvoiceMatchAction" NOT NULL,
    "aiConfidence"         "InvoiceConfidence" NOT NULL,
    "aiContext"            TEXT,
    "pricePerKgNormalized" DECIMAL(10,2),
    "previousPricePerKg"   DECIMAL(10,2),
    "priceChangePercent"   DECIMAL(6,2),
    "priceChangeLevel"     "PriceChangeLevel" NOT NULL,
    "boundingBoxes"        JSONB,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invoice_status_progress_idx" ON "Invoice"("status", "progress");

-- CreateIndex
CREATE INDEX "Invoice_receivedAt_idx" ON "Invoice"("receivedAt");

-- CreateIndex
CREATE INDEX "Invoice_supplierNameLower_idx" ON "Invoice"("supplierNameLower");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_supplierNameLower_invoiceNumber_invoiceDate_key" ON "Invoice"("supplierNameLower", "invoiceNumber", "invoiceDate");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_lineIndex_idx" ON "InvoiceLine"("invoiceId", "lineIndex");

-- CreateIndex
CREATE INDEX "InvoiceLine_matchedIngredientId_idx" ON "InvoiceLine"("matchedIngredientId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_revertedById_fkey" FOREIGN KEY ("revertedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_matchedIngredientId_fkey" FOREIGN KEY ("matchedIngredientId") REFERENCES "Ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
