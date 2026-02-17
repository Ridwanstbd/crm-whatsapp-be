-- CreateTable
CREATE TABLE `CampaignAutoReply` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `traceWords` TEXT NOT NULL,
    `replyMap` TEXT NOT NULL,
    `delayReply` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CampaignAutoReply_campaignId_key`(`campaignId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CampaignAutoReply` ADD CONSTRAINT `CampaignAutoReply_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `CampaignMessage`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
