-- AlterEnum
ALTER TYPE "MenuStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterTable
ALTER TABLE "MenuCycle" ADD COLUMN     "rejectionComment" TEXT;
