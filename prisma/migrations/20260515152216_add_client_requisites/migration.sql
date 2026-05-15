-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "bankAccount" TEXT,
ADD COLUMN     "bankBic" TEXT,
ADD COLUMN     "bankCorrAccount" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "contractDate" DATE,
ADD COLUMN     "contractNumber" TEXT,
ADD COLUMN     "defaultOurLegalEntityId" TEXT,
ADD COLUMN     "inn" TEXT,
ADD COLUMN     "kpp" TEXT,
ADD COLUMN     "legalAddress" TEXT,
ADD COLUMN     "legalName" TEXT,
ADD COLUMN     "ogrn" TEXT;

-- CreateIndex
CREATE INDEX "Client_defaultOurLegalEntityId_idx" ON "Client"("defaultOurLegalEntityId");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_defaultOurLegalEntityId_fkey" FOREIGN KEY ("defaultOurLegalEntityId") REFERENCES "OurLegalEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
