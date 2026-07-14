-- AlterTable
ALTER TABLE `User` MODIFY `platform` ENUM('web', 'android', 'ios', 'vk', 'facebook', 'yandex', 'itch') NOT NULL DEFAULT 'web';
