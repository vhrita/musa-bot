# ── builder stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# Build deps for native modules (e.g. @discordjs/opus)
RUN apk add --no-cache \
    g++ \
    make \
    python3

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci

COPY src/ ./src/

RUN npm run build

# ── production stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS production

# yt-dlp version to bake — override at build time with --build-arg YTDLP_VERSION=...
ARG YTDLP_VERSION=2026.06.09

# Runtime deps:
#   ffmpeg        — audio transcoding
#   python3/pip   — needed to install yt-dlp from PyPI (arch-agnostic, always latest)
#   su-exec       — privilege-drop in entrypoint
RUN apk add --no-cache ffmpeg python3 py3-pip su-exec

# Install yt-dlp via pip (supports both linux/amd64 and linux/arm64 transparently).
# --break-system-packages is required on Alpine ≥3.20 (PEP-668 enforced).
# Pinned to YTDLP_VERSION for reproducibility; bump the ARG above to update.
RUN pip install --no-cache-dir --break-system-packages "yt-dlp==${YTDLP_VERSION}"

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force
COPY --from=builder /app/dist ./dist
# Fallback asset used in embeds
COPY musa.png ./

RUN mkdir -p /app/logs

RUN addgroup -g 1001 -S nodejs && adduser -S musa -u 1001

# Entrypoint fixes cookie-volume ownership then drops to uid 1001 (musa)
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]
