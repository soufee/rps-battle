-- CreateTable
CREATE TABLE `Championship` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'running',
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `totalMatches` INTEGER NOT NULL,
    `completedMatches` INTEGER NOT NULL DEFAULT 0,
    `standings` JSON NULL,
    `schedule` JSON NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChampionshipMatch` (
    `id` VARCHAR(191) NOT NULL,
    `championshipId` VARCHAR(191) NOT NULL,
    `round` INTEGER NOT NULL,
    `topBotId` VARCHAR(191) NOT NULL,
    `bottomBotId` VARCHAR(191) NOT NULL,
    `topBotName` VARCHAR(191) NOT NULL,
    `bottomBotName` VARCHAR(191) NOT NULL,
    `winner` VARCHAR(191) NOT NULL,
    `loser` VARCHAR(191) NULL,
    `reason` VARCHAR(191) NULL,
    `durationSec` INTEGER NOT NULL,
    `totalMoves` INTEGER NULL,
    `timedOut` BOOLEAN NOT NULL DEFAULT false,
    `battleLog` JSON NOT NULL,
    `screenshotPath` VARCHAR(191) NULL,
    `playedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ChampionshipMatch_championshipId_idx`(`championshipId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ChampionshipMatch` ADD CONSTRAINT `ChampionshipMatch_championshipId_fkey` FOREIGN KEY (`championshipId`) REFERENCES `Championship`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;