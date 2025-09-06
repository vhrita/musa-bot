# TODO — Musa Bot & YouTube Resolver (Etapa 0 follow‑ups)

Items deferred intentionally for later work:

## Security/Networking

- Replace `--no-check-certificate` in yt‑dlp calls with a safer default or behind an explicit env toggle (diagnostic only). Assess CA trust in target environments instead of disabling TLS checks.

## Streaming/Resilience

- Expose environment variables to tune resume behavior in the resolver proxy (e.g., `RESUME_MAX_RETRIES`, `RESUME_RETRY_DELAY_MS`). Defaults are stable; parameterization adds flexibility.

## Testing

- Add integration tests for the resolver (e.g., supertest) covering `/search`, `/stream`, `/proxy-stream`, including invalid inputs and rate limit responses.
- Add e2e smoke tests between bot and resolver in a docker‑compose environment.

## Observability

- Optional metrics (lightweight) for queue depth, activeCalls, and rate limiter buckets — keep overhead minimal for Pi.

## Documentation

- Expand troubleshooting with common yt‑dlp/ffmpeg issues and cookie refresh workflows.

---

# Próximas Etapas (pós‑Etapa 0)

## ETAPA 1 — Melhores práticas de engenharia

- CRÍTICA
  - Pipeline CI obrigatória (lint, build, test) em PRs com cache e relatórios.
  - Secret scanning no CI (gitleaks/trufflehog) e proteção de branches principais.
- ALTA
  - Aumentar cobertura de testes unitários (MusicManager, ResolverYouTubeService, MultiSourceManager, comandos chave) com mocks de rede/ffmpeg.
  - Padronizar respostas de erro do resolver (shape consistente com `error`, `code`, `details`).
  - Adicionar X-Request-ID por requisição e repasse aos logs (correlação entre bot e resolver).
- MÉDIA
  - Classes de erro tipadas no bot (ex.: `PlayerError`, `ResolverError`) com mapeamento para mensagens amigáveis.
  - Middleware de erro no resolver para respostas uniformes e truncamento seguro de mensagens longas.
- BAIXA
  - Prettier + script `format` (sem alterar estilo atual).
  - Husky (pre-commit: lint, typecheck opcional).
- MELHORIAS/OUTRAS
  - Relatórios de cobertura (istanbul) e limiares mínimos (ex.: 40–60%).

## ETAPA 2 — Design Systems & Design Patterns

- CRÍTICA
  - (n/d)
- ALTA
  - Extrair a lógica de “resume”/proxy do resolver para módulo dedicado (Strategy/Adapter) facilitando testes.
  - Adapter para yt-dlp (montagem de args e parsing) reutilizável entre bot e resolver.
- MÉDIA
  - Factory para criação de recursos de áudio (YouTube/Radio) unificando cleanup e logs.
- BAIXA
  - Observer simples para eventos de playback (para métricas futuras).
- MELHORIAS/OUTRAS
  - Mapear pontos de extensão (novas fontes de áudio) com interfaces claras.

## ETAPA 3 — Código duplicado & reutilização

- CRÍTICA
  - (n/d)
- ALTA
  - Unificar montagem de flags do yt-dlp (bot vs resolver) em util compartilhado (mesmo que copiado inicialmente, evitar drift).
- MÉDIA
  - Reaproveitar util de sanitização de URLs (safe log) entre bot e resolver.
- BAIXA
  - Consolidar helpers de validação simples (boolean/int clamp) onde fizer sentido no resolver.
- MELHORIAS/OUTRAS
  - Catálogo de utilitários com exemplos de uso.

## ETAPA 4 — Convenções e consistência

- CRÍTICA
  - (n/d)
- ALTA
  - Prettier + `.editorconfig` (tabs/spaces, EOL, charset) para consistência entre repos/editores.
- MÉDIA
  - Auditar imports absolutos/relativos (paths do tsconfig) e padronizar.
- BAIXA
  - Scripts `lint:strict` e `format:check` no CI.
- MELHORIAS/OUTRAS
  - Guia curto de contribuição (CONTRIBUTING.md) com comandos usuais.

## ETAPA 5 — Variáveis de ambiente & .env.example

- CRÍTICA
  - (n/d) — Bot já validado via Zod; Resolver tem config leve centralizada.
- ALTA
  - Alinhar exemplos de env entre README principal, docs/BOT_CONFIG.md e youtube-resolver/README.md (mantidos em sincronia via tabela única no futuro).
- MÉDIA
  - docker-compose de exemplo com variáveis (prod/dev) e comentários.
- BAIXA
  - Script simples para verificar envs obrigatórias antes do start (make/ts-node opcional).
- MELHORIAS/OUTRAS
  - Template de `.env` específico para dev local com resolver.

## ETAPA 6 — Lixo, legado e código inutilizado

- CRÍTICA
  - (n/d)
- ALTA
  - Revisão de código morto: funções/utilidades não usadas, comentários datados, logs excessivos.
- MÉDIA
  - Consolidar duplicações pequenas (strings de comandos ffmpeg) onde aplicável.
- BAIXA
  - Remover artefatos antigos em docs/scripts que não se aplicam mais.
- MELHORIAS/OUTRAS
  - Checklist periódico de limpeza a cada release.

## ETAPA 7 — Estrutura de pastas

- CRÍTICA
  - (n/d)
- ALTA
  - Avaliar separar o resolver em repositório próprio no futuro (para release ciclo independente) mantendo alinhamento via submódulo/subtree (opcional).
- MÉDIA
  - Criar diretório `docs/` (feito) e manter seções organizadas por tema.
- BAIXA
  - Padronizar `scripts/` para utilidades de build/deploy locais.
- MELHORIAS/OUTRAS
  - Explorar monorepo (pnpm workspaces) somente se necessário em longo prazo.

## ETAPA 8 — Segurança & vulnerabilidades

- CRÍTICA
  - Substituir `--no-check-certificate` do yt‑dlp por padrão seguro ou condição por env (diagnóstico apenas). Avaliar cadeia de CA no container/host em vez de desabilitar TLS.
- ALTA
  - Autenticação opcional entre bot ↔ resolver (ex.: `X-Resolver-Token` com HMAC/TOTP) para cenários fora de VPN.
  - TOCTOU hardening no proxy: verificar consistência de IP entre resolução e requisição (mitigar mudanças DNS maliciosas durante o fluxo).
- MÉDIA
  - Security headers adicionais (resolver): `Strict-Transport-Security` quando atrás de HTTPS terminação; `Referrer-Policy`.
- BAIXA
  - Verificação adicional de CORS (preflight cache, métodos e headers permitidos mínimos).
- MELHORIAS/OUTRAS
  - Script de segurança (npm) para rodar `npm audit --omit=dev` e relatório resumido.

## ETAPA 9 — Dependências & deprecations

- CRÍTICA
  - (n/d)
- ALTA
  - Pipeline `npm audit` e `npm outdated` com alerta em PRs.
- MÉDIA
  - Avaliar upgrades major de libs (discord.js, axios, winston) com changelog e smoke tests.
- BAIXA
  - Fix de ranges de versões para evitar drift inesperado.
- MELHORIAS/OUTRAS
  - Renovate/Dependabot configurado para PRs automáticos (com labels).

## ETAPA 10 — Sumário executivo & plano de ação

- CRÍTICA
  - (n/d)
- ALTA
  - Planejar sequência de PRs pequena e objetiva (1 assunto por PR: CI; testes; segurança; formatação; doc).
- MÉDIA
  - Mapa de riscos e mitigação (curto) para mudanças maiores (ex.: autenticação, split de repo).
- BAIXA
  - Changelog simples por release (semântica opcional).
- MELHORIAS/OUTRAS
  - Tagging de versões e release notes.
