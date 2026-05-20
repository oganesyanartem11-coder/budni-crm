-- AlterTable
ALTER TABLE "MenuCycle" ADD COLUMN     "menuImportId" TEXT;

-- AlterTable
ALTER TABLE "MenuImport" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "rejectionComment" TEXT,
ADD COLUMN     "startDate" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "MenuCycle_menuImportId_idx" ON "MenuCycle"("menuImportId");

-- AddForeignKey
ALTER TABLE "MenuCycle" ADD CONSTRAINT "MenuCycle_menuImportId_fkey" FOREIGN KEY ("menuImportId") REFERENCES "MenuImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuImport" ADD CONSTRAINT "MenuImport_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
