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

# Production stage
FROM node:18-alpine AS production

# Install runtime dependencies and create user
# Note: yt-dlp automatically installs python3 as dependency
RUN apk add --no-cache \
    ffmpeg \
    yt-dlp \
    && rm -rf /var/cache/apk/* && \
    addgroup -g 1001 -S nodejs && \
    adduser -S musa -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Create logs directory and set permissions
RUN mkdir -p logs && \
    chown -R musa:nodejs /app

# Switch to non-root user
USER musa

# Expose port (optional, for health checks)
EXPOSE 3000

# Start the application
CMD ["npm", "start"]