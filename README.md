<div align="center">
  <img src="musa.png" alt="Musa - Fairy of Music" width="280">
  <h1>Musa Bot</h1>
  <p><em>Fairy of Music — bringing rhythm to the WINX Discord since 2016</em></p>
  <p>
    <img alt="Node 22" src="https://img.shields.io/badge/node-22-brightgreen">
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.3-blue">
    <img alt="Discord.js" src="https://img.shields.io/badge/discord.js-v14-5865F2">
    <img alt="License" src="https://img.shields.io/badge/license-MIT-purple">
  </p>
</div>

---

Musa is a TypeScript Discord music bot named after the Fairy of Music from Winx Club. She's been running in the WINX server since 2016 (originally in Python — see the [`legacy`](https://github.com/vhrita/musa-bot/tree/legacy) branch). The current version is a full TypeScript rewrite built around a multi-source music architecture, Zod-validated configuration, and a clean separation between the bot process and the YouTube resolver.

Purple theme. Structured logs. Slash commands. No magic — just clean code with some fairy dust.

---

## Architecture

### Multi-source routing

Musa routes every search through `MultiSourceManager`, which queries enabled services in priority order and returns the first successful hit. Each source extends `BaseMusicService` and exposes a `search(query, maxResults)` interface:

| Source           | Class                                       | Default priority | Notes                                       |
| ---------------- | ------------------------------------------- | ---------------- | ------------------------------------------- |
| Radio            | `RadioService`                              | 1                | HTTP stream URLs, live only                 |
| Internet Archive | `InternetArchiveService`                    | 2                | Free audio archive, high-quality recordings |
| YouTube          | `YouTubeService` / `ResolverYouTubeService` | 3                | See resolver section below                  |

Spotify is supported as a **metadata layer** only (`SpotifyPlaylistProvider`, `TrackResolver`): playlist and track metadata are fetched via the Spotify Web API, then each track is resolved to a YouTube URL for playback. Spotify streaming is not used.

### Bot vs resolver split

YouTube is the main bottleneck. Datacenter IPs are frequently blocked by YouTube's bot detection. Musa handles this with two modes:

- **Resolver mode** (`RESOLVER_URL` is set): the bot delegates all YouTube operations (search, stream URL extraction) to an external `youtube-resolver` service — typically running on a Raspberry Pi or home network with a residential IP. The resolver communicates over HTTP with configurable timeouts (`RESOLVER_SEARCH_TIMEOUT_SECONDS`, `RESOLVER_STREAM_TIMEOUT_SECONDS`).
- **Direct mode** (no `RESOLVER_URL`): `ResolverYouTubeService` falls back to running `yt-dlp` in-process. Useful for local dev or if your host has a clean IP. Expect higher block rates on datacenter VMs.

Both modes support cookie authentication (`COOKIES_PATH`) to access age-restricted content and improve metadata quality.

### Playback pipeline

```
slash command
    → MultiSourceManager.search()
        → enabled services in priority order
            → first successful MusicSource returned
    → MusicManager.addToQueue()
        → ffmpeg + @discordjs/voice AudioPlayer
        → prefetch: resolves next N stream URLs in background (configurable)
```

Stream URLs for YouTube are short-lived signed CDN links — they are resolved lazily and cached for `STREAM_CACHE_TTL_MINUTES` to avoid stale URL errors.

### Configuration

All config is validated at startup by a Zod schema (`src/config/schema.ts`). Invalid values throw with a descriptive error before the bot connects. No silent defaults for required fields.

---

## Requirements

- Node.js 22 (see `.nvmrc`)
- `ffmpeg` in PATH — required for audio transcoding
- `yt-dlp` in PATH — required if YouTube is enabled (install via `pip3 install yt-dlp`)
- A Discord bot token with `applications.commands` scope and the following intents: `Guilds`, `GuildMessages`, `GuildVoiceStates`

---

## Local dev setup

```bash
# 1. Clone and install
git clone https://github.com/vhrita/musa-bot.git
cd musa-bot
npm install

# 2. Configure
cp .env.template .env
# Edit .env — at minimum set DISCORD_TOKEN and DISCORD_CLIENT_ID

# 3. Register slash commands (run once per bot application)
npm run deploy

# 4. Start dev server
npm run dev        # tsx watch — hot reload

# Or build and run
npm run build
npm start
```

### Scripts

| Command             | What it does                              |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Start with hot reload via `tsx watch`     |
| `npm run build`     | Compile TypeScript to `dist/`             |
| `npm start`         | Run the compiled output                   |
| `npm run deploy`    | Register slash commands with Discord      |
| `npm run typecheck` | Type-check without emitting (CI-friendly) |
| `npm run lint`      | ESLint over `src/`                        |
| `npm run lint:fix`  | ESLint with auto-fix                      |
| `npm run format`    | Prettier write over entire repo           |
| `npm test`          | Build + Jest                              |

---

## Commands

| Command              | Description                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/play <query\|url>` | Search across all enabled sources and add the best match. Accepts plain text queries, YouTube URLs, and Spotify track URLs.          |
| `/playlist <url>`    | Ingest a full playlist from YouTube or Spotify. First track flushes immediately; remaining tracks are added in configurable batches. |
| `/radio <genre>`     | Add a curated radio station stream by genre.                                                                                         |
| `/queue`             | Show the current queue with now-playing and upcoming tracks.                                                                         |
| `/skip`              | Skip the current track.                                                                                                              |
| `/pause`             | Pause playback.                                                                                                                      |
| `/resume`            | Resume playback.                                                                                                                     |
| `/stop`              | Stop playback and clear the queue.                                                                                                   |
| `/shuffle`           | Shuffle the queue in place. Re-triggers prefetch for the new order.                                                                  |

---

## Environment variables

All variables are optional except `DISCORD_TOKEN`. Defaults are shown in `.env.template`.

### Core

| Variable            | Default | Description                                                                   |
| ------------------- | ------- | ----------------------------------------------------------------------------- |
| `DISCORD_TOKEN`     | —       | **Required.** Bot token from Discord Developer Portal.                        |
| `DISCORD_CLIENT_ID` | `""`    | Application ID — required for slash command registration.                     |
| `GUILD_ID`          | —       | Restrict slash command registration to one guild (instant refresh, dev only). |
| `MUSA_CHANNEL_ID`   | —       | If set, Musa only accepts commands in this channel.                           |
| `PREFIX`            | `!`     | Legacy prefix (slash commands are primary).                                   |

### Sources

| Variable                    | Default | Description                                                                             |
| --------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `ENABLE_YOUTUBE`            | `false` | Enable YouTube source.                                                                  |
| `ENABLE_INTERNET_ARCHIVE`   | `true`  | Enable Internet Archive source.                                                         |
| `ENABLE_RADIO`              | `true`  | Enable radio stream source.                                                             |
| `ENABLE_SPOTIFY`            | `false` | Enable Spotify metadata layer (requires `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET`). |
| `YOUTUBE_PRIORITY`          | `3`     | Source priority (lower = checked first).                                                |
| `INTERNET_ARCHIVE_PRIORITY` | `2`     |                                                                                         |
| `RADIO_PRIORITY`            | `1`     |                                                                                         |
| `MAX_RESULTS_PER_SOURCE`    | `3`     | Max results fetched per source per search.                                              |

### YouTube / yt-dlp

| Variable                          | Default | Description                                                                                                    |
| --------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `RESOLVER_URL`                    | —       | URL of the external youtube-resolver service (e.g. `http://raspberry:3001`). If unset, yt-dlp runs in-process. |
| `RESOLVER_SEARCH_TIMEOUT_SECONDS` | `180`   | HTTP timeout for resolver search calls.                                                                        |
| `RESOLVER_STREAM_TIMEOUT_SECONDS` | `180`   | HTTP timeout for resolver stream URL calls.                                                                    |
| `RESOLVER_HEALTH_TIMEOUT_SECONDS` | `5`     | Health-check timeout before fallback.                                                                          |
| `COOKIES_PATH`                    | —       | Path to a Netscape-format cookies file for yt-dlp (e.g. `/cookies/cookies.txt`).                               |
| `YTDLP_PROXY` / `YOUTUBE_PROXY`   | —       | Proxy URL passed to yt-dlp.                                                                                    |
| `YTDLP_SOCKET_TIMEOUT_SECONDS`    | `20`    | yt-dlp socket timeout.                                                                                         |

### Spotify

| Variable                  | Default | Description                                      |
| ------------------------- | ------- | ------------------------------------------------ |
| `SPOTIFY_CLIENT_ID`       | —       | Spotify app client ID (Client Credentials flow). |
| `SPOTIFY_CLIENT_SECRET`   | —       | Spotify app client secret.                       |
| `SPOTIFY_TIMEOUT_SECONDS` | `12`    | Timeout for Spotify API requests.                |
| `SPOTIFY_MARKET`          | `US`    | ISO 3166-1 alpha-2 market for track lookups.     |

### Queue and playback

| Variable                   | Default | Description                                                      |
| -------------------------- | ------- | ---------------------------------------------------------------- |
| `MAX_QUEUE_SIZE`           | `100`   | Maximum number of tracks in the queue.                           |
| `INACTIVITY_TIMEOUT`       | `60`    | Seconds before auto-disconnect when nothing is playing.          |
| `EMPTY_CHANNEL_TIMEOUT`    | `120`   | Seconds before auto-disconnect when the voice channel is empty.  |
| `PREFETCH_ENABLED`         | `true`  | Pre-resolve stream URLs for upcoming tracks.                     |
| `PREFETCH_COUNT`           | `2`     | How many upcoming tracks to prefetch.                            |
| `PREFETCH_ALL`             | `false` | Prefetch the entire queue (use with caution on large playlists). |
| `STREAM_CACHE_TTL_MINUTES` | `10`    | How long to cache resolved stream URLs.                          |
| `SEARCH_TIMEOUT_SECONDS`   | `10`    | Max time to wait for a source to return results.                 |

### Playlist ingestion

| Variable                      | Default | Description                                                  |
| ----------------------------- | ------- | ------------------------------------------------------------ |
| `YT_PLAYLIST_BATCH`           | `100`   | Batch size for YouTube playlist ingestion.                   |
| `SPOTIFY_PLAYLIST_BATCH`      | `50`    | Batch size for Spotify playlist ingestion.                   |
| `SPOTIFY_RESOLVE_CONCURRENCY` | `4`     | Concurrent track resolutions during Spotify playlist import. |
| `DEDUPE_PLAYLIST`             | `true`  | Skip duplicate tracks within the same ingestion.             |

### Logging

| Variable          | Default                       | Description                          |
| ----------------- | ----------------------------- | ------------------------------------ |
| `LOG_LEVEL`       | `INFO` (prod) / `DEBUG` (dev) | Winston log level.                   |
| `LOG_MAX_SIZE_MB` | `10`                          | Max log file size before rotation.   |
| `LOG_MAX_FILES`   | `3`                           | Number of rotated log files to keep. |

---

## Docker deployment

The production image is published to GHCR as a multi-arch build (amd64 + arm64). The image uses `node:22-alpine3.20` and installs `yt-dlp` via pip at build time.

```bash
# docker-compose (recommended — handles volume mounts for cookies and logs)
docker compose up -d

# Manual
docker pull ghcr.io/vhrita/musa-bot:latest
docker run -d \
  --name musa-bot \
  --env-file .env \
  -v $(pwd)/cookies:/cookies:ro \
  -v $(pwd)/logs:/app/logs \
  ghcr.io/vhrita/musa-bot:latest
```

The `youtube-resolver` service runs separately. See `youtube-resolver/README.md` for its setup and the `docker-compose.yml` at the repo root for the full two-service stack.

---

## Project structure

```
musa-bot/
├── src/
│   ├── commands/          # Slash command handlers
│   ├── config/            # Zod schema + config loader
│   ├── events/            # Discord.js event handlers
│   ├── services/          # Music sources and managers
│   │   ├── BaseMusicService.ts
│   │   ├── MultiSourceManager.ts
│   │   ├── MusicManager.ts
│   │   ├── RadioService.ts
│   │   ├── InternetArchiveService.ts
│   │   ├── YouTubeService.ts
│   │   ├── ResolverYouTubeService.ts
│   │   ├── TrackResolver.ts
│   │   └── providers/     # Spotify provider
│   ├── types/             # TypeScript types and discord.d.ts augmentation
│   └── utils/             # Logger, Discord helpers, URL utils
├── tests/
├── youtube-resolver/      # Companion resolver service (separate process)
├── .github/workflows/ci.yml
├── .env.template
├── .prettierrc
├── .editorconfig
├── .nvmrc                 # Node 22
├── docker-compose.yml
└── Dockerfile
```

---

## Troubleshooting

**YouTube errors / no stream URL**

YouTube blocks datacenter IPs aggressively. If you see `yt-dlp` errors or silent failures:

1. Set up a `youtube-resolver` on a device with a residential IP and point `RESOLVER_URL` at it.
2. Export YouTube cookies from a logged-in browser session and mount the file at `COOKIES_PATH`.
3. Check that `yt-dlp` is up to date (`pip3 install --upgrade yt-dlp`).

**Commands not appearing in Discord**

Run `npm run deploy` to (re-)register slash commands. For instant registration during development, set `GUILD_ID` to your test server's ID.

**Bot joins voice but produces no audio**

Confirm `ffmpeg` is installed and in PATH. The bot uses `ffmpeg-static` as a fallback, but the system binary is preferred.

**`DISCORD_TOKEN` validation error at startup**

Musa validates all config through Zod at startup. Check the error message — it will point to the exact field and the validation rule that failed.

---

## Legacy

The original Python implementation (2016–2023) is preserved in the [`legacy`](https://github.com/vhrita/musa-bot/tree/legacy) branch for historical reference. The current TypeScript version is a full rewrite.

---

<div align="center">
  <img src="musa.png" alt="Musa" width="160">
  <br>
  <em>"In the power of music, we find the magic that connects us all"</em>
  <br>
  <strong>Built with TypeScript and a touch of fairy magic 🎵</strong>
</div>
