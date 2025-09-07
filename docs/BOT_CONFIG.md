# Musa Bot — Configuration (12‑Factor with Zod)

The bot loads all configuration from environment variables and validates them at startup. Missing or invalid values cause a clear startup error.

NODE_ENV affects defaults:
- `production` → default `LOG_LEVEL=INFO`
- other (`development`, `test`) → default `LOG_LEVEL=DEBUG`

## Required

- `DISCORD_TOKEN`: Discord bot token.

## Common

- `DISCORD_CLIENT_ID` (optional): App client ID, used by deploy-commands.
- `PREFIX` (default `!`): Legacy prefix (slash commands recommended).
- `MUSA_CHANNEL_ID` (optional): If set, bot responds only in this channel.
- `GUILD_ID` (optional): For fast per‑guild command deployment.

## Services

Booleans accept `true|false|1|0|yes|no`.

- `ENABLE_YOUTUBE` (default `false`)
- `ENABLE_INTERNET_ARCHIVE` (default `true`)
- `ENABLE_RADIO` (default `true`)
- `ENABLE_SPOTIFY` (default `false`)
- Priorities (1 = higher):
  - `YOUTUBE_PRIORITY` (default `3`, 1..10)
  - `INTERNET_ARCHIVE_PRIORITY` (default `2`, 1..10)
  - `RADIO_PRIORITY` (default `1`, 1..10)
- `MAX_RESULTS_PER_SOURCE` (default `3`, 1..25)

## Resolver & YouTube (when using Raspberry Pi resolver)

- `RESOLVER_URL` (optional): e.g. `http://raspberry:3001`
- `COOKIES_PATH` (optional): canonical path to cookies.txt (recognized by bot and resolver)
- `YTDLP_COOKIES` (optional): path to cookies.txt (bot only; alias of `COOKIES_PATH`)
- Proxy (either name is accepted):
  - `YTDLP_PROXY`
  - `YOUTUBE_PROXY`

Behavioral notes:
- The resolver (and bot fallback) prefers YouTube Music for searches when supported by `yt-dlp`. If the installed `yt-dlp` doesn't support the `ytmusicsearchN:` scheme, the preference is automatically disabled and the system falls back to `ytsearch` without noisy errors.

## Music behavior

- `MAX_QUEUE_SIZE` (default `100`, 1..1000)
- `SEARCH_TIMEOUT_SECONDS` (default `10`, 1..120)
- `INACTIVITY_TIMEOUT` (default `60`, 10..3600, seconds)
- `EMPTY_CHANNEL_TIMEOUT` (default `120`, 10..7200, seconds)

## Prefetch (stream URL pre‑resolve)

- `PREFETCH_ENABLED` (default `true`)
- `PREFETCH_COUNT` (default `2`, 0..10)
- `PREFETCH_ALL` (default `false`)
- `STREAM_CACHE_TTL_MINUTES` (default `10`, 1..120)

## Playlist ingestion tuning

- `YT_PLAYLIST_BATCH` (default `100`, 1..500): YouTube/YT Music ingestion batch size. The very first track is flushed immediately to start playback faster; this variable controls subsequent flushes.
- `SPOTIFY_PLAYLIST_BATCH` (default `50`, 1..200): Spotify ingestion batch size after the first flush.
- `SPOTIFY_RESOLVE_CONCURRENCY` (default `4`, 1..10): How many Spotify tracks are resolved to YouTube concurrently.
- `DEDUPE_PLAYLIST` (default `true`): Avoid duplicates within the same ingestion session.

## Spotify Web API

- `SPOTIFY_CLIENT_ID` (optional)
- `SPOTIFY_CLIENT_SECRET` (optional)
- `SPOTIFY_TIMEOUT_SECONDS` (default `12`)
- `SPOTIFY_MARKET` (default `US`): two‑letter ISO code (e.g., `BR`, `US`) used when resolving tracks.

## Logging

- `LOG_LEVEL` (optional): One of `ERROR|WARN|INFO|DEBUG|VERBOSE|SILLY`. If unset, chosen by `NODE_ENV`.
- `LOG_MAX_SIZE_MB` (default `10`)
- `LOG_MAX_FILES` (default `3`)

## Notes

- All values are clamped/validated at startup. If invalid, the bot fails fast with a helpful message.
- Secrets should not be committed — use `.env` locally and real env vars in production.
