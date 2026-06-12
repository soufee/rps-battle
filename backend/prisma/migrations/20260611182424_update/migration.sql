-- AlterTable
ALTER TABLE `Stats` ADD COLUMN `tournamentStage` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `tournamentVersion` INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE `PvpOpponentStats` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `opponentId` VARCHAR(191) NOT NULL,
    `wins` INTEGER NOT NULL DEFAULT 0,
    `losses` INTEGER NOT NULL DEFAULT 0,
    `draws` INTEGER NOT NULL DEFAULT 0,
    `gamesPlayed` INTEGER NOT NULL DEFAULT 0,
    `lastPlayedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PvpOpponentStats_userId_idx`(`userId`),
    UNIQUE INDEX `PvpOpponentStats_userId_opponentId_key`(`userId`, `opponentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PvpOpponentStats` ADD CONSTRAINT `PvpOpponentStats_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PvpOpponentStats` ADD CONSTRAINT `PvpOpponentStats_opponentId_fkey` FOREIGN KEY (`opponentId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
