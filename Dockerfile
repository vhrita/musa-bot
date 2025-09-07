# Use Node.js 18 LTS Alpine image for smaller size
FROM node:18-alpine AS builder

# Install system dependencies for building
RUN apk add --no-cache \
    g++ \
    make \
    python3

# Set working directory
WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev dependencies for building)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build the application
RUN npm run build

# --- production stage ---
FROM node:18-alpine AS production

# deps de runtime
RUN apk add --no-cache ffmpeg yt-dlp su-exec

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force
COPY --from=builder /app/dist ./dist
# Include fallback asset used in embeds
COPY musa.png ./

# (opcional) manter logs em /app
RUN mkdir -p /app/logs

# crie o usuário/grupo
RUN addgroup -g 1001 -S nodejs && adduser -S musa -u 1001

# ENTRYPOINT que acerta permissões do volume e troca de usuário
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# não fixe USER aqui; o entrypoint roda como root e usa su-exec para virar "musa"
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]
