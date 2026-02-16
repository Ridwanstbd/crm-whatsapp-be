-- AlterTable
ALTER TABLE `messagelog` ADD COLUMN `campaignId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `CampaignMessage` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MessageLog` ADD CONSTRAINT `MessageLog_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `CampaignMessage`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
