FROM node:lts-alpine

# Install dependencies optimized for Pi 3
RUN apk add --no-cache \
    python3 \
    ffmpeg \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install with minimal dependencies
RUN npm ci --omit=dev --no-audit --no-fund

# Copy application files
COPY . .

# Create necessary directories
RUN mkdir -p logs /data/cookies /tmp \
  && ln -s /data/cookies /app/cookies \
  && chmod 755 /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 -G nodejs
USER nodejs

# Expose port
EXPOSE 3001

# Set memory limits for Pi 3
ENV NODE_OPTIONS="--max-old-space-size=512 --gc-interval=100 --expose-gc"
ENV UV_THREADPOOL_SIZE=2

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Start the application
CMD ["node", "server.js"]
