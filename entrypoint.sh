#!/bin/sh
set -e

# Diretório de cookies vindo do ambiente, default para /cookies
COOKIES_DIR="${COOKIES_DIR:-/cookies}"

# Garante que existe e é do usuário 'musa'
mkdir -p "$COOKIES_DIR" || true
# tenta ajustar permissão; se for volume com restrição, não falhe o start
chown -R 1001:1001 "$COOKIES_DIR" 2>/dev/null || true

# idem para logs se você usa /app/logs
mkdir -p /app/logs || true
chown -R 1001:1001 /app/logs 2>/dev/null || true

# Troca para o usuário 'musa' e executa o comando
exec su-exec 1001:1001 "$@"