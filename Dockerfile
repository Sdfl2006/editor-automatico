FROM node:20-slim

# Instalar Chromium del sistema y fuentes necesarias
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Indicar a Puppeteer que NO descargue su propio Chrome
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# Indicar a Puppeteer la ruta exacta del Chromium que acabamos de instalar
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]