// Basic tests for config loader (Zod schema)

const MODULE_PATH = '../dist/config/schema';

function reloadLoader() {
  delete require.cache[require.resolve(MODULE_PATH)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(MODULE_PATH);
}

function withVars(overrides, fn) {
  const saved = {};
  const keys = Object.keys(overrides);
  for (const k of keys) {
    saved[k] = process.env[k];
    const v = overrides[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// Keys set by tests/setupEnv.js that we may want to clear in some tests
const SETUP_KEYS = [
  'DISCORD_TOKEN', 'DISCORD_CLIENT_ID',
  'ENABLE_YOUTUBE', 'ENABLE_INTERNET_ARCHIVE', 'ENABLE_RADIO',
  'LOG_LEVEL',
  'MAX_QUEUE_SIZE', 'SEARCH_TIMEOUT_SECONDS', 'INACTIVITY_TIMEOUT', 'EMPTY_CHANNEL_TIMEOUT',
  'PREFETCH_ENABLED', 'PREFETCH_COUNT', 'PREFETCH_ALL', 'STREAM_CACHE_TTL_MINUTES',
  'RESOLVER_URL', 'YTDLP_COOKIES', 'YTDLP_PROXY', 'YOUTUBE_PROXY', 'GUILD_ID'
];

function clearSetupEnvExcept(excepts = []) {
  const removals = {};
  for (const k of SETUP_KEYS) {
    if (!excepts.includes(k)) removals[k] = undefined;
  }
  return removals;
}

describe('config schema loader', () => {
  test('fails without DISCORD_TOKEN', () => {
    const { loadBotConfig } = reloadLoader();
    withVars({ DISCORD_TOKEN: undefined }, () => {
      expect(() => loadBotConfig()).toThrow(/DISCORD_TOKEN is required|Invalid environment configuration/i);
    });
  });

  test('applies sane defaults with only DISCORD_TOKEN', () => {
    const { loadBotConfig } = reloadLoader();
    withVars({ ...clearSetupEnvExcept(['DISCORD_TOKEN']), DISCORD_TOKEN: 'x-test' }, () => {
      const cfg = loadBotConfig();
      expect(cfg.token).toBe('x-test');
      expect(cfg.prefix).toBe('!');
      // In NODE_ENV=test the default log level is DEBUG
      expect(cfg.logging.level).toBe('DEBUG');
      expect(cfg.services.youtube.enabled).toBe(false);
      expect(cfg.services.radio.enabled).toBe(true);
      expect(cfg.music.maxQueueSize).toBeGreaterThan(0);
      expect(typeof cfg.music.searchTimeout).toBe('number');
    });
  });

  test('boolean coercion and proxy alias', () => {
    const { loadBotConfig } = reloadLoader();
    withVars({
      ...clearSetupEnvExcept(['DISCORD_TOKEN']),
      DISCORD_TOKEN: 'x',
      ENABLE_YOUTUBE: '1',
      ENABLE_RADIO: '0',
      YOUTUBE_PROXY: 'http://proxy:3128'
    }, () => {
      const cfg = loadBotConfig();
      expect(cfg.services.youtube.enabled).toBe(true);
      expect(cfg.services.radio.enabled).toBe(false);
      expect(cfg.ytdlpProxy).toBe('http://proxy:3128');
    });
  });

  test('invalid LOG_LEVEL falls back to default', () => {
    const { loadBotConfig } = reloadLoader();
    withVars({ ...clearSetupEnvExcept(['DISCORD_TOKEN']), DISCORD_TOKEN: 'x', LOG_LEVEL: 'NOPE' }, () => {
      const cfg = loadBotConfig();
      // In NODE_ENV=test, invalid LOG_LEVEL falls back to DEBUG
      expect(cfg.logging.level).toBe('DEBUG');
    });
  });

  test('invalid RESOLVER_URL protocol throws', () => {
    const { loadBotConfig } = reloadLoader();
    withVars({ ...clearSetupEnvExcept(['DISCORD_TOKEN']), DISCORD_TOKEN: 'x', RESOLVER_URL: 'ftp://host' }, () => {
      expect(() => loadBotConfig()).toThrow(/RESOLVER_URL must start with http\/https/i);
    });
  });
});
