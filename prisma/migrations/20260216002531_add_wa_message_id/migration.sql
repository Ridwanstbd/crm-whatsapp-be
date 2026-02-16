/*
  Warnings:

  - A unique constraint covering the columns `[waMessageId]` on the table `MessageLog` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `waMessageId` to the `MessageLog` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `messagelog` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `waMessageId` VARCHAR(191) NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX `MessageLog_waMessageId_key` ON `MessageLog`(`waMessageId`);
