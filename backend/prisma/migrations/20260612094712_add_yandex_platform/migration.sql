-- AlterTable
ALTER TABLE `user` MODIFY `platform` ENUM('web', 'android', 'ios', 'vk', 'facebook', 'yandex') NOT NULL DEFAULT 'web';
