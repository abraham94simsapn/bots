#!/bin/bash

# Обновление пакетов и установка зависимостей
sudo apt update
sudo apt install -y nodejs npm

# Установка глобальных пакетов
npm install -g steam-user node-telegram-bot-api natural

# Запуск бота в папке checker
cd checker
node index.js &
CHECKER_PID=$!

# Запуск бота в папке wedqwd
cd ../wedqwd
node index.js &
WEDQWD_PID=$!

# Ожидание завершения обоих процессов
wait $CHECKER_PID $WEDQWD_PID
