-- AlterEnum
ALTER TYPE "BorisEventType" ADD VALUE 'SAMEDAY_ORDER_LOCKED';

-- AlterTable
ALTER TABLE "ClientLocation" ADD COLUMN     "cutoffHourMsk" INTEGER,
ADD COLUMN     "cutoffMinuteMsk" INTEGER,
ADD COLUMN     "sameDayDelivery" BOOLEAN NOT NULL DEFAULT false;
