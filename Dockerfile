# ── builder stage ──────────────────────────────────────────────────────────────
# ⚠️  Pin Alpine 3.20 (musl 1.2.5) de propósito: @discordjs/opus@0.10.0 só tem
# prebuild musl-1.2.5 pra Node 22 (node-v127). Alpine 3.21+ usa musl 1.2.6 →
# prebuild 404 → compila libopus do source → quebra em arm64 (bug ARM NEON
# celt_inner_prod_neon). NÃO bumpe a versão do Alpine sem reverificar o prebuild.
FROM node:22-alpine3.20 AS builder

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

# Prune dev deps in-place so node_modules is production-only (incl. compiled native addons)
RUN npm prune --omit=dev

# ── production stage ────────────────────────────────────────────────────────────
# ⚠️  Mesma pin do builder: Alpine 3.20 (musl 1.2.5). Ver comentário acima.
FROM node:22-alpine3.20 AS production

# yt-dlp version to bake — override at build time with --build-arg YTDLP_VERSION=...
ARG YTDLP_VERSION=2026.06.09

# Runtime deps:
#   ffmpeg        — audio transcoding
#   python3/pip   — needed to install yt-dlp from PyPI (arch-agnostic, always latest)
#   su-exec       — privilege-drop in entrypoint
#   libstdc++     — required at runtime by @discordjs/opus compiled from source (musl build)
RUN apk add --no-cache ffmpeg python3 py3-pip su-exec libstdc++

# Install yt-dlp via pip (supports both linux/amd64 and linux/arm64 transparently).
# --break-system-packages is required on Alpine ≥3.20 (PEP-668 enforced).
# Pinned to YTDLP_VERSION for reproducibility; bump the ARG above to update.
RUN pip install --no-cache-dir --break-system-packages "yt-dlp==${YTDLP_VERSION}"

WORKDIR /app
COPY package*.json ./
# node_modules (incl. @discordjs/opus compiled for musl) come from the builder stage.
# No npm ci here — avoids recompiling native addons without build tools.
COPY --from=builder /app/node_modules ./node_modules
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
