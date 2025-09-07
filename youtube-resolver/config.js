// Centralized configuration loader for YouTube Resolver (12-factor style)
// No external deps to keep Docker build lean on Pi

function bool(name, def = false) {
  const v = process.env[name];
  if (typeof v === 'undefined') return def;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

function intInRange(name, def, min, max) {
  const raw = process.env[name];
  const n = raw !== undefined ? Number(raw) : def;
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function csv(name, defCsv) {
  const v = process.env[name];
  const base = typeof v === 'string' ? v : (typeof defCsv === 'string' ? defCsv : '');
  const list = base.split(',').map(s => s.trim()).filter(Boolean);
  return list;
}

function loadConfig() {
  const cfg = {
    port: intInRange('PORT', 3001, 1, 65535),
    // CORS
    allowedOrigins: csv('ALLOWED_ORIGINS', ''),
    // Destination validation for proxy
    allowedDestSchemes: csv('ALLOWED_DEST_SCHEMES', 'https'),
    allowedDestHostSuffixes: csv('ALLOWED_DEST_HOST_SUFFIXES', 'googlevideo.com'),
    allowedDestCidrs: csv('ALLOWED_DEST_CIDRS', ''),
    // Cookies
    ytdlpCookiesPath: process.env.YTDLP_COOKIES_PATH || process.env.YTDLP_COOKIES || process.env.COOKIES_PATH || '',
    // Quick search cookies toggle
    quickSearchCookies: bool('QUICK_SEARCH_COOKIES', false),

    // Rate limit (per IP)
    rateLimitWindowMs: intInRange('RATE_LIMIT_WINDOW_MS', 60_000, 1_000, 600_000),
    rateLimitMax: intInRange('RATE_LIMIT_MAX', 60, 1, 10_000),
    rateLimitBurst: intInRange('RATE_LIMIT_BURST', 20, 1, 1_000),

    // Logging
    logLevel: (process.env.NODE_ENV || '').toLowerCase() === 'production' ? 'info' : 'debug',
    // Logging limits
    logMaxSizeMB: intInRange('LOG_MAX_SIZE_MB', 5, 1, 200),
    logMaxFiles: intInRange('LOG_MAX_FILES', 3, 1, 50),

    // Trust proxy (for correct req.ip behind reverse proxies)
    trustProxy: bool('TRUST_PROXY', false),

    // Timeouts and yt-dlp tuning
    searchQuickTimeoutMs: intInRange('SEARCH_QUICK_TIMEOUT_MS', 45_000, 5_000, 300_000),
    searchTimeoutMs: intInRange('SEARCH_TIMEOUT_MS', 90_000, 10_000, 600_000),
    streamTimeoutMs: intInRange('STREAM_TIMEOUT_MS', 120_000, 10_000, 600_000),
    ytdlpSocketTimeoutSec: intInRange('YTDLP_SOCKET_TIMEOUT_SECONDS', 45, 5, 300),
  };

  // Basic validation
  if (!cfg.allowedDestSchemes.length) cfg.allowedDestSchemes = ['https'];
  if (!cfg.allowedDestHostSuffixes.length) cfg.allowedDestHostSuffixes = ['googlevideo.com'];

  return cfg;
}

const config = loadConfig();

module.exports = { config };
