-- Script for HeidiSQL / MySQL Database creation for ego Messenger
CREATE DATABASE IF NOT EXISTS `messenger_db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `messenger_db`;

-- 1. Table users (with avatar_url, bio, age)
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(50) NOT NULL UNIQUE,
  `email` VARCHAR(100) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `is_verified` TINYINT(1) DEFAULT 0,
  `is_banned` TINYINT(1) DEFAULT 0,
  `avatar_url` TEXT NULL,
  `bio` TEXT NULL,
  `age` INT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Safe column additions for existing databases
ALTER TABLE `users` ADD COLUMN IF NOT EXISTS `avatar_url` TEXT NULL;
ALTER TABLE `users` ADD COLUMN IF NOT EXISTS `bio` TEXT NULL;
ALTER TABLE `users` ADD COLUMN IF NOT EXISTS `age` INT NULL;

-- 2. Table contacts
CREATE TABLE IF NOT EXISTS `contacts` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `contact_id` INT NOT NULL,
  `status` VARCHAR(20) DEFAULT 'accepted',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`contact_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  UNIQUE KEY `unique_user_contact` (`user_id`, `contact_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Table servers
CREATE TABLE IF NOT EXISTS `servers` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL,
  `owner_id` INT NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Table server_members
CREATE TABLE IF NOT EXISTS `server_members` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `server_id` INT NOT NULL,
  `user_id` INT NOT NULL,
  `role` VARCHAR(20) DEFAULT 'member', -- 'admin', 'moderator', 'member'
  `joined_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  UNIQUE KEY `unique_server_user` (`server_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. Table channels
CREATE TABLE IF NOT EXISTS `channels` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `server_id` INT NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `type` VARCHAR(20) DEFAULT 'text',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. Table messages
CREATE TABLE IF NOT EXISTS `messages` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `channel_id` INT NULL,
  `sender_id` INT NOT NULL,
  `recipient_id` INT NULL,
  `content` LONGTEXT NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
