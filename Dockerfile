FROM node:18-slim

# Установка зависимостей для Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Переменные для Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Копируем package.json
COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/

# Устанавливаем зависимости сервера
RUN cd server && npm install --production

# Устанавливаем и билдим клиент
RUN cd client && npm install && npm run build

# Копируем исходники
COPY server ./server
COPY client/dist ./client/dist

# Создаём директории для данных
RUN mkdir -p /app/server/data /app/server/uploads /app/server/.wwebjs_auth

# Порт
EXPOSE 3001

# Запуск
CMD ["node", "server/index.js"]