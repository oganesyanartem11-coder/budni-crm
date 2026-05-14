/*
  Warnings:

  - You are about to drop the column `maxChatId` on the `User` table. All the data in the column will be lost.
  - Made the column `locationId` on table `ClientMealConfig` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "User_maxChatId_key";

-- AlterTable
ALTER TABLE "ClientMealConfig" ALTER COLUMN "locationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "maxChatId";
