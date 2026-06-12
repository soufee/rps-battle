-- AlterTable
ALTER TABLE `User` MODIFY `platform` ENUM('web', 'android', 'ios', 'vk', 'facebook', 'yandex') NOT NULL DEFAULT 'web';
