// Jest setup: mock all runtime env for unit tests

// Ensure NODE_ENV=test so config defaults (e.g. log level) use non-production values.
// Jest sets this automatically when NODE_ENV is absent, but the `npm test` script runs
// `npm run build && jest` which means the build step can leave NODE_ENV as-is (e.g.
// "production"), and Jest inherits it. Pinning it here is the safest guarantee.
process.env.NODE_ENV = 'test';

process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = 'test-client-id';

// Disable optional services to avoid side-effects during module import
process.env.ENABLE_YOUTUBE = 'false';
process.env.ENABLE_INTERNET_ARCHIVE = 'false';
process.env.ENABLE_RADIO = 'false';

// Keep logs quiet in tests
process.env.LOG_LEVEL = 'error';

// Music defaults
process.env.MAX_QUEUE_SIZE = '100';
process.env.SEARCH_TIMEOUT_SECONDS = '10';
process.env.INACTIVITY_TIMEOUT = '60';
process.env.EMPTY_CHANNEL_TIMEOUT = '120';

// Prefetch defaults
process.env.PREFETCH_ENABLED = 'false';
process.env.PREFETCH_COUNT = '0';
process.env.PREFETCH_ALL = 'false';
process.env.STREAM_CACHE_TTL_MINUTES = '10';
