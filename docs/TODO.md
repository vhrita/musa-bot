# TODO — Musa Bot & YouTube Resolver

Atualizado 2026-06-15: itens de tooling/CI concluídos removidos.

Items deferred intentionally for later work:

## Security/Networking

- Replace `--no-check-certificate` in yt‑dlp calls with a safer default or behind an explicit env toggle (diagnostic only). Assess CA trust in target environments instead of disabling TLS checks.

## Streaming/Resilience

- Expose environment variables to tune resume behavior in the resolver proxy (e.g., `RESUME_MAX_RETRIES`, `RESUME_RETRY_DELAY_MS`). Defaults are stable; parameterization adds flexibility.

## Testing

- Add integration tests for the resolver (e.g., supertest) covering `/search`, `/stream`, `/proxy-stream`, including invalid inputs and rate limit responses.
- Add e2e smoke tests between bot and resolver in a docker‑compose environment.
- Increase unit test coverage (MusicManager, ResolverYouTubeService, MultiSourceManager, key commands) with network/ffmpeg mocks.

## Observability

- Optional metrics (lightweight) for queue depth, activeCalls, and rate limiter buckets — keep overhead minimal for Pi.

## Documentation

- Expand troubleshooting with common yt‑dlp/ffmpeg issues and cookie refresh workflows.
- Align env examples between README, and `youtube-resolver/README.md` (single source of truth table).

---

# Próximas Etapas

## Engenharia

- CRÍTICA
  - Secret scanning no CI (gitleaks/trufflehog) e proteção de branches principais.
- ALTA
  - Padronizar respostas de erro do resolver (shape consistente com `error`, `code`, `details`).
  - Adicionar X-Request-ID por requisição e repasse aos logs (correlação entre bot e resolver).
- MÉDIA
  - Classes de erro tipadas no bot (ex.: `PlayerError`, `ResolverError`) com mapeamento para mensagens amigáveis.
  - Middleware de erro no resolver para respostas uniformes e truncamento seguro de mensagens longas.
- BAIXA
  - Husky (pre-commit: lint, typecheck opcional).

## Design Patterns

- ALTA
  - Extrair a lógica de "resume"/proxy do resolver para módulo dedicado (Strategy/Adapter) facilitando testes.
  - Adapter para yt-dlp (montagem de args e parsing) reutilizável entre bot e resolver.
- MÉDIA
  - Factory para criação de recursos de áudio (YouTube/Radio) unificando cleanup e logs.
- BAIXA
  - Observer simples para eventos de playback (para métricas futuras).

## Reutilização de Código

- ALTA
  - Unificar montagem de flags do yt-dlp (bot vs resolver) em util compartilhado.
- MÉDIA
  - Reaproveitar util de sanitização de URLs (safe log) entre bot e resolver.

## Segurança

- CRÍTICA
  - Substituir `--no-check-certificate` do yt‑dlp por padrão seguro ou condição por env (diagnóstico apenas).
- ALTA
  - Autenticação opcional entre bot ↔ resolver (ex.: `X-Resolver-Token` com HMAC/TOTP) para cenários fora de VPN.
  - TOCTOU hardening no proxy: verificar consistência de IP entre resolução e requisição.
- MÉDIA
  - Security headers adicionais (resolver): `Strict-Transport-Security` quando atrás de HTTPS; `Referrer-Policy`.
- BAIXA
  - Verificação adicional de CORS (métodos e headers permitidos mínimos).

## Dependências

- ALTA
  - Pipeline `npm audit` e `npm outdated` com alerta em PRs.
- MÉDIA
  - Avaliar upgrades major de libs (discord.js, axios, winston) com changelog e smoke tests.
- BAIXA
  - Renovate/Dependabot configurado para PRs automáticos (com labels).

## Estrutura

- ALTA
  - Avaliar separar o resolver em repositório próprio no futuro (release cycle independente).
- BAIXA
  - Padronizar `scripts/` para utilidades de build/deploy locais.

## Changelog

- Tagging de versões e release notes simples por release.
