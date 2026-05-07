-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "sourceConfigId" TEXT;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_sourceConfigId_fkey" FOREIGN KEY ("sourceConfigId") REFERENCES "ClientMealConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
