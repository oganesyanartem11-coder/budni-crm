-- CreateEnum
CREATE TYPE "MenuImportSource" AS ENUM ('PHOTO', 'EXCEL');

-- CreateTable
CREATE TABLE "MenuImport" (
    "id" TEXT NOT NULL,
    "source" "MenuImportSource" NOT NULL,
    "status" "MenuStatus" NOT NULL DEFAULT 'DRAFT',
    "rawText" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "createdById" TEXT,
    "menuCycleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MenuImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MenuImport_status_idx" ON "MenuImport"("status");

-- AlterTable
ALTER TABLE "Dish" ADD COLUMN "originalName" TEXT,
ADD COLUMN "correctedName" TEXT,
ADD COLUMN "correctionLevel" TEXT,
ADD COLUMN "correctionNote" TEXT,
ADD COLUMN "menuImportId" TEXT;

-- AddForeignKey
ALTER TABLE "MenuImport" ADD CONSTRAINT "MenuImport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuImport" ADD CONSTRAINT "MenuImport_menuCycleId_fkey" FOREIGN KEY ("menuCycleId") REFERENCES "MenuCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dish" ADD CONSTRAINT "Dish_menuImportId_fkey" FOREIGN KEY ("menuImportId") REFERENCES "MenuImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
