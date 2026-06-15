#!/bin/sh
set -e

# Ensure app logs directory exists and is owned by the musa user
mkdir -p /app/logs || true
chown -R 1001:1001 /app/logs 2>/dev/null || true

# Cache dir para o EJS solver do yt-dlp (XDG_CACHE_HOME=/app/.cache)
# O yt-dlp-ejs e o yt-dlp usam este diretório para cachear o script solver.
# Sem ownership correto o download do solver falha silenciosamente.
mkdir -p /app/.cache || true
chown -R 1001:1001 /app/.cache 2>/dev/null || true

# Switch to user 'musa' and execute the command
exec su-exec 1001:1001 "$@"