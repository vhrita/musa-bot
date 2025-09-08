import { BotConfig } from '../types/music';
import { z } from 'zod';

// Helpers to coerce and validate env values
const bool = () =>
  z.preprocess((v) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(s)) return true;
      if (['false', '0', 'no', 'n'].includes(s)) return false;
    }
    return v;
  }, z.boolean());

const intInRange = (min: number, max: number, def: number) =>
  z.preprocess((v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return def;
  }, z.number().int().min(min).max(max));

const allowedLogLevels = ['error', 'warn', 'info', 'debug', 'verbose', 'silly'] as const;

// Schema of raw env
// (removed unused urlString helper)

const EnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().optional().default(''),
  PREFIX: z.string().optional().default('!'),
  MUSA_CHANNEL_ID: z.string().optional(),
  GUILD_ID: z.string().optional(),

  // Optional external resolver and yt-dlp settings
  RESOLVER_URL: z
    .string()
    .optional()
    .refine((v) => (v ? /^https?:\/\//i.test(v) : true), {
      message: 'RESOLVER_URL must start with http/https',
    }),
  RESOLVER_SEARCH_TIMEOUT_SECONDS: intInRange(1, 600, 180).optional().default(180),
  RESOLVER_STREAM_TIMEOUT_SECONDS: intInRange(1, 600, 180).optional().default(180),
  RESOLVER_HEALTH_TIMEOUT_SECONDS: intInRange(1, 60, 5).optional().default(5),
  RESOLVER_FAST_SEARCH_TIMEOUT_SECONDS: intInRange(1, 600, 45).optional().default(45),
  COOKIES_PATH: z.string().optional(),
  YTDLP_COOKIES: z.string().optional(),
  YTDLP_PROXY: z.string().optional(),
  YOUTUBE_PROXY: z.string().optional(),
  YTDLP_SOCKET_TIMEOUT_SECONDS: intInRange(1, 120, 20).optional().default(20),

  ENABLE_YOUTUBE: bool().optional().default(false),
  ENABLE_INTERNET_ARCHIVE: bool().optional().default(true),
  ENABLE_RADIO: bool().optional().default(true),
  ENABLE_SPOTIFY: bool().optional().default(false),

  YOUTUBE_PRIORITY: intInRange(1, 10, 3).optional().default(3),
  INTERNET_ARCHIVE_PRIORITY: intInRange(1, 10, 2).optional().default(2),
  RADIO_PRIORITY: intInRange(1, 10, 1).optional().default(1),
  MAX_RESULTS_PER_SOURCE: intInRange(1, 25, 3).optional().default(3),

  SEARCH_TIMEOUT_SECONDS: intInRange(1, 120, 10).optional().default(10),
  MAX_QUEUE_SIZE: intInRange(1, 1000, 100).optional().default(100),
  INACTIVITY_TIMEOUT: intInRange(10, 3600, 60).optional().default(60),
  EMPTY_CHANNEL_TIMEOUT: intInRange(10, 7200, 120).optional().default(120),

  PREFETCH_ENABLED: bool().optional().default(true),
  PREFETCH_COUNT: intInRange(0, 10, 2).optional().default(2),
  PREFETCH_ALL: bool().optional().default(false),
  STREAM_CACHE_TTL_MINUTES: intInRange(1, 120, 10).optional().default(10),
  // Playlist ingestion tuning
  YT_PLAYLIST_BATCH: intInRange(1, 500, 100).optional().default(100),
  SPOTIFY_PLAYLIST_BATCH: intInRange(1, 200, 50).optional().default(50),
  SPOTIFY_RESOLVE_CONCURRENCY: intInRange(1, 10, 4).optional().default(4),
  DEDUPE_PLAYLIST: bool().optional().default(true),

  // Spotify Web API (Client Credentials)
  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),
  SPOTIFY_TIMEOUT_SECONDS: intInRange(1, 120, 12).optional().default(12),
  SPOTIFY_MARKET: z.string().optional().default('US'),

  LOG_LEVEL: z.string().optional(),
  LOG_MAX_SIZE_MB: intInRange(1, 200, 10).optional().default(10),
  LOG_MAX_FILES: intInRange(1, 20, 3).optional().default(3),
});

export function loadBotConfig(): BotConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const env = parsed.data as z.infer<typeof EnvSchema>;
  const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
  const defaultLogLevel = nodeEnv === 'production' ? 'INFO' : 'DEBUG';
  const inputLevel = env.LOG_LEVEL ? String(env.LOG_LEVEL).trim() : defaultLogLevel;
  const inputLevelLower = inputLevel.toLowerCase();
  const normalizedLevel = allowedLogLevels.includes(inputLevelLower as any)
    ? inputLevelLower.toUpperCase()
    : defaultLogLevel;

  const cfg: BotConfig = {
    token: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID || '',
    prefix: env.PREFIX || '!',
    musaChannelId: env.MUSA_CHANNEL_ID,
    ...(env.GUILD_ID ? { guildId: env.GUILD_ID } : {}),
    ...(env.RESOLVER_URL ? { resolverUrl: env.RESOLVER_URL } : {}),
    resolver: {
      searchTimeoutMs: (env.RESOLVER_SEARCH_TIMEOUT_SECONDS as number) * 1000,
      fastSearchTimeoutMs: (env.RESOLVER_FAST_SEARCH_TIMEOUT_SECONDS as number) * 1000,
      streamTimeoutMs: (env.RESOLVER_STREAM_TIMEOUT_SECONDS as number) * 1000,
      healthTimeoutMs: (env.RESOLVER_HEALTH_TIMEOUT_SECONDS as number) * 1000,
    },
    ...((env.YTDLP_COOKIES || env.COOKIES_PATH) ? { ytdlpCookies: (env.YTDLP_COOKIES || env.COOKIES_PATH)! } : {}),
    ...(env.YTDLP_PROXY || env.YOUTUBE_PROXY ? { ytdlpProxy: (env.YTDLP_PROXY || env.YOUTUBE_PROXY)! } : {}),
    ...(env.YTDLP_SOCKET_TIMEOUT_SECONDS ? { ytdlpSocketTimeoutSeconds: env.YTDLP_SOCKET_TIMEOUT_SECONDS as number } : { ytdlpSocketTimeoutSeconds: 20 }),
    services: {
      youtube: {
        enabled: env.ENABLE_YOUTUBE as boolean,
        priority: env.YOUTUBE_PRIORITY as number,
        maxResults: env.MAX_RESULTS_PER_SOURCE as number,
      },
      internetArchive: {
        enabled: env.ENABLE_INTERNET_ARCHIVE as boolean,
        priority: env.INTERNET_ARCHIVE_PRIORITY as number,
        maxResults: env.MAX_RESULTS_PER_SOURCE as number,
      },
      radio: {
        enabled: env.ENABLE_RADIO as boolean,
        priority: env.RADIO_PRIORITY as number,
        maxResults: env.MAX_RESULTS_PER_SOURCE as number,
      },
    },
    spotify: {
      enabled: env.ENABLE_SPOTIFY as boolean,
      ...(env.SPOTIFY_CLIENT_ID ? { clientId: env.SPOTIFY_CLIENT_ID } : {}),
      ...(env.SPOTIFY_CLIENT_SECRET ? { clientSecret: env.SPOTIFY_CLIENT_SECRET } : {}),
      timeoutMs: (env.SPOTIFY_TIMEOUT_SECONDS as number) * 1000,
      market: env.SPOTIFY_MARKET,
    },
    logging: {
      level: normalizedLevel,
      maxSizeBytes: (env.LOG_MAX_SIZE_MB as number) * 1024 * 1024,
      maxFiles: env.LOG_MAX_FILES as number,
    },
    music: {
      searchTimeout: (env.SEARCH_TIMEOUT_SECONDS as number) * 1000,
      maxQueueSize: env.MAX_QUEUE_SIZE as number,
      inactivityTimeout: (env.INACTIVITY_TIMEOUT as number) * 1000,
      emptyChannelTimeout: (env.EMPTY_CHANNEL_TIMEOUT as number) * 1000,
      prefetchEnabled: env.PREFETCH_ENABLED as boolean,
      prefetchCount: env.PREFETCH_COUNT as number,
      prefetchAll: env.PREFETCH_ALL as boolean,
      streamCacheTTL: (env.STREAM_CACHE_TTL_MINUTES as number) * 60 * 1000,
      youtubeBatchSize: env.YT_PLAYLIST_BATCH as number,
      spotifyBatchSize: env.SPOTIFY_PLAYLIST_BATCH as number,
      spotifyResolveConcurrency: env.SPOTIFY_RESOLVE_CONCURRENCY as number,
      dedupeOnPlaylist: env.DEDUPE_PLAYLIST as boolean,
    },
  };

  return cfg;
}
