FROM node:lts-alpine

WORKDIR /app

# Dependências mínimas + yt-dlp do repositório Alpine
RUN apk add --no-cache \
    python3 \
    ffmpeg \
    curl \
    ca-certificates \
    yt-dlp

# Variáveis úteis
ENV YTDLP_COOKIES_PATH=/data/cookies/cookies.txt \
    YTDLP_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36" \
    NODE_ENV=production

# Instala deps Node
COPY package*.json ./
RUN npm ci --omit=dev

# Código
COPY . .

# Pasta de logs e cookies; symlink p/ compat com 'cookies/cookies.txt'
RUN mkdir -p logs /data/cookies /tmp \
 && ln -s /data/cookies /app/cookies || true \
 && chmod 777 /tmp

# Usuário não-root
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3001/health || exit 1

CMD ["node", "server.js"]