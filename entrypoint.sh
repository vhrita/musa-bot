#!/bin/sh
set -e

# Ensure app logs directory exists and is owned by the musa user
mkdir -p /app/logs || true
chown -R 1001:1001 /app/logs 2>/dev/null || true

# Switch to user 'musa' and execute the command
exec su-exec 1001:1001 "$@"