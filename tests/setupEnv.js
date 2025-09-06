// Jest setup: mock all runtime env for unit tests

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

