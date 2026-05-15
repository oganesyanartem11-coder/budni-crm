-- CreateEnum
CREATE TYPE "LegalEntityType" AS ENUM ('INDIVIDUAL_ENTREPRENEUR', 'LLC');

-- CreateEnum
CREATE TYPE "VatMode" AS ENUM ('NONE', 'VAT_10_INCLUSIVE');

-- CreateTable
CREATE TABLE "OurLegalEntity" (
    "id" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "entityType" "LegalEntityType" NOT NULL,
    "inn" TEXT NOT NULL,
    "kpp" TEXT,
    "ogrn" TEXT NOT NULL,
    "legalAddress" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "bankName" TEXT NOT NULL,
    "bankBic" TEXT NOT NULL,
    "bankAccount" TEXT NOT NULL,
    "bankCorrAccount" TEXT NOT NULL,
    "directorName" TEXT NOT NULL,
    "directorPosition" TEXT NOT NULL DEFAULT 'Директор',
    "vatMode" "VatMode" NOT NULL DEFAULT 'NONE',
    "vatRate" DECIMAL(5,2),
    "lastDocumentNumber" INTEGER NOT NULL DEFAULT 0,
    "lastDocumentYear" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OurLegalEntity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OurLegalEntity_inn_key" ON "OurLegalEntity"("inn");

-- CreateIndex
CREATE UNIQUE INDEX "OurLegalEntity_ogrn_key" ON "OurLegalEntity"("ogrn");

-- CreateIndex
CREATE INDEX "OurLegalEntity_isActive_idx" ON "OurLegalEntity"("isActive");
