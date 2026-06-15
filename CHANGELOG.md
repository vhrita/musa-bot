# Changelog

All notable changes to Musa Bot are documented here.

## [Unreleased] — Repo Polish

### Added

- `.prettierrc` (printWidth 110, singleQuote, trailingComma all) and `.editorconfig` for consistent formatting across editors
- `eslint-config-prettier` to the ESLint extends chain, eliminating style conflicts between ESLint and Prettier
- `npm run format` script (`prettier -w .`) and `npm run typecheck` script (`tsc --noEmit`)
- `useUnknownInCatchVariables: true` in `tsconfig.json` — catch-block variables now type as `unknown` instead of `any`
- `LICENSE` (MIT, author vhrita)
- `.nvmrc` pinned to Node 22
- `.github/workflows/ci.yml` — typecheck, lint, test, and build on every push/PR to main and master
- Per-user per-command cooldown (2 s) in `interactionCreate.ts` using a module-scoped `Map<string, number>` (replaces the `global.__musaCooldowns` + `@ts-ignore` pattern from the WIP branch)

### Fixed

- `'@typescript-eslint/recommended'` in `.eslintrc.js` was missing the `plugin:` prefix, causing ESLint to fail to resolve the config. Corrected to `'plugin:@typescript-eslint/recommended'`
- `errorOutput` variable collected stderr in `play.ts::fetchYouTubeMeta` and `YouTubeService::fetchMeta` but was never read; removed variable and the orphaned `p.stderr.on('data')` listener
- `Client` was imported in `src/types/discord.d.ts` purely for a module-augmentation block where it is not needed as a value; removed to clear `@typescript-eslint/no-unused-vars` error
- `require()` calls used for dynamic file loading (commands, events) and conditional `fs` access (cookie checks) now carry `// eslint-disable-next-line @typescript-eslint/no-var-requires` comments so `npm run lint` exits clean

### Changed

- `GatewayIntentBits.MessageContent` removed from client intents in `src/index.ts`. Confirmed `messageCreate.ts` only reads `message.channelId`, `message.author`, `message.deletable`, and `message.id` — none of which require the privileged `MessageContent` intent
- README fully rewritten: architecture, source routing, bot↔resolver split, egress challenge, env table, command reference, deploy guide, troubleshooting

## [2.0.0] — Image Refresh (2026)

- Base image pinned to `node:22-alpine3.20`
- `yt-dlp` installed via `pip3` (replaces the stale binary that was bundled in the image)
- `@discordjs/voice` upgraded to 0.19.2
- Resolver-disabled mode: when `RESOLVER_URL` is not set, `ResolverYouTubeService` falls back to running `yt-dlp` directly in-process instead of erroring out
- Multi-arch Docker build (amd64 + arm64) published to GHCR

## [1.x] — TypeScript Rewrite

Original rewrite from Python (see `legacy` branch) to TypeScript with Discord.js v14, slash commands, multi-source architecture, Zod config validation, and Winston structured logging.
