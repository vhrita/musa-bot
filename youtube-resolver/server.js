const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const winston = require('winston');
const axios = require('axios');
const dns = require('dns').promises;
const net = require('net');
const { config: resolverConfig } = require('./config');

// Force garbage collection for Pi 3 memory management
if (global.gc) {
  setInterval(() => {
    global.gc();
  }, 30000); // Every 30 seconds
}

const app = express();
const port = resolverConfig.port;

// Ultra-minimal cache for Pi 3
const searchCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes (reduced)
const MAX_CACHE_SIZE = 20; // Reduced cache for Pi 3

// Note: We no longer use the deprecated/pseudo "ytmusicsearchN:" scheme.
// Preference for YouTube Music is applied via extractor-args (player_client=web_music).

// Rate limiting and circuit breaker
const activeCalls = new Map(); // Track active calls by URL
const urlQueues = new Map(); // Queue pending requests per URL
const MAX_CONCURRENT_CALLS = 1; // REDUCED: Max 1 concurrent call per URL to prevent FFmpeg multi-connection abuse
const CIRCUIT_BREAKER = {
  failures: 0,
  lastFailure: 0,
  isOpen: false,
  threshold: 3, // REDUCED: Open circuit after 3 failures (was 5)
  timeout: 60000 // INCREASED: Reset after 60 seconds (was 30)
};

// Configure logging
const logger = winston.createLogger({
  level: resolverConfig.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'resolver.log', maxsize: resolverConfig.logMaxSizeMB * 1024 * 1024, maxFiles: resolverConfig.logMaxFiles })
  ]
});

// CORS with env-configured allowed origins
// ALLOWED_ORIGINS="https://bot.example.com,https://my.site"
const allowedOrigins = resolverConfig.allowedOrigins;

// Runtime flag: temporarily suspend cookies after invalidation
let COOKIES_SUSPENDED_UNTIL = 0; // epoch ms
function areCookiesSuspended() { return Date.now() < COOKIES_SUSPENDED_UNTIL; }
function suspendCookiesFor(ms) {
  COOKIES_SUSPENDED_UNTIL = Math.max(COOKIES_SUSPENDED_UNTIL, Date.now() + ms);
  try {
    logger.warn('cookies_suspended', { until: new Date(COOKIES_SUSPENDED_UNTIL).toISOString(), forMs: ms });
  } catch { /* ignore */ }
}
function containsInvalidCookiesError(s) {
  if (!s) return false;
  return /(account\s+)?cookies?\s+are\s+no\s+longer\s+valid/i.test(s) || /invalid\s+cookie/i.test(s);
}

app.use(cors({
  origin: (origin, cb) => {
    // If no origins configured, disable CORS (no headers added)
    if (!allowedOrigins.length) return cb(null, false);
    if (!origin) return cb(null, false);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));
// Limit JSON body size to prevent abuse while matching bot payload sizes
app.use(express.json({ limit: '10kb' }));
// Security header
app.disable('x-powered-by');
// Optional trust proxy for correct client IP when behind reverse proxies
if (resolverConfig.trustProxy) {
  app.set('trust proxy', true);
}

// Safe logging helpers for stream URLs
function sanitizeStreamMeta(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const expire = u.searchParams.get('expire');
    const meta = { streamHost: u.host, streamPath: u.pathname };
    if (expire && !Number.isNaN(Number(expire))) meta.expire = Number(expire);
    return meta;
  } catch {
    return { streamHost: 'invalid', streamPath: '' };
  }
}

function buildUrlLogMeta(rawUrl) {
  const base = sanitizeStreamMeta(rawUrl);
  // In non-production, also include full URL to aid debugging
  if ((process.env.NODE_ENV || '').toLowerCase() !== 'production') {
    return { ...base, originalUrl: rawUrl };
  }
  return base;
}

// Cache management functions
function getCacheKey(query, maxResults) {
  return `${query.toLowerCase().trim()}:${maxResults}`;
}

function getCachedResult(query, maxResults) {
  const key = getCacheKey(query, maxResults);
  const cached = searchCache.get(key);
  
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    logger.info('Cache hit', { query, maxResults, age: Date.now() - cached.timestamp });
    return cached.results;
  }
  
  if (cached) {
    searchCache.delete(key); // Remove expired entry
  }
  
  return null;
}

// Circuit breaker functions
function isCircuitOpen() {
  if (CIRCUIT_BREAKER.isOpen) {
    const timeSinceLastFailure = Date.now() - CIRCUIT_BREAKER.lastFailure;
    if (timeSinceLastFailure > CIRCUIT_BREAKER.timeout) {
      // Reset circuit breaker
      CIRCUIT_BREAKER.isOpen = false;
      CIRCUIT_BREAKER.failures = 0;
      logger.info('Circuit breaker reset');
      return false;
    }
    return true;
  }
  return false;
}

function recordFailure() {
  CIRCUIT_BREAKER.failures++;
  CIRCUIT_BREAKER.lastFailure = Date.now();
  
  if (CIRCUIT_BREAKER.failures >= CIRCUIT_BREAKER.threshold) {
    CIRCUIT_BREAKER.isOpen = true;
    logger.warn('Circuit breaker opened', { failures: CIRCUIT_BREAKER.failures });
  }
}

function recordSuccess() {
  CIRCUIT_BREAKER.failures = Math.max(0, CIRCUIT_BREAKER.failures - 1);
}

// Rate limiting for concurrent calls
function canMakeCall(url) {
  const activeCount = activeCalls.get(url) || 0;
  return activeCount < MAX_CONCURRENT_CALLS;
}

function recordActiveCall(url) {
  const current = activeCalls.get(url) || 0;
  activeCalls.set(url, current + 1);
}

function recordCallComplete(url) {
  const current = activeCalls.get(url) || 0;
  if (current <= 1) {
    activeCalls.delete(url);
  } else {
    activeCalls.set(url, current - 1);
  }
  
  // Process any queued requests for this URL
  processUrlQueue(url);
}

// URL queue management
function addToUrlQueue(url, req, res) {
  if (!urlQueues.has(url)) {
    urlQueues.set(url, []);
  }
  
  const queue = urlQueues.get(url);
  queue.push({ req, res, timestamp: Date.now() });
  
  logger.info('Request queued', { ...buildUrlLogMeta(url), queueSize: queue.length });
  
  // Set timeout to reject old requests
  setTimeout(() => {
    const index = queue.findIndex(item => item.req === req);
    if (index !== -1) {
      queue.splice(index, 1);
      if (!res.headersSent) {
        res.status(408).json({ error: 'Request timeout - too many concurrent requests' });
      }
    }
  }, 10000); // 10 second timeout
}

function processUrlQueue(url) {
  const queue = urlQueues.get(url);
  if (!queue || queue.length === 0) {
    return;
  }
  
  if (canMakeCall(url)) {
    const { req, res } = queue.shift();
    if (!res.headersSent && !res.writableEnded) {
      // Continue processing this request
      handleProxyStreamRequest(req, res, url);
    } else {
      // Client already gone; skip
      processUrlQueue(url);
    }
  }
}

function setCachedResult(query, maxResults, results) {
  const key = getCacheKey(query, maxResults);
  
  // Implement LRU eviction if cache is full
  if (searchCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = searchCache.keys().next().value;
    searchCache.delete(oldestKey);
    logger.info('Cache eviction', { evictedKey: oldestKey, newKey: key });
  }
  
  searchCache.set(key, {
    results,
    timestamp: Date.now()
  });
  
  logger.info('Cache stored', { query, maxResults, cacheSize: searchCache.size });
}

// Function to get cookie arguments for yt-dlp
function getCookieArgs() {
  const fs = require('fs');
  const path = require('path');
  const srcPath = resolverConfig.ytdlpCookiesPath; // may come from YTDLP_COOKIES_PATH/YTDLP_COOKIES/COOKIES_PATH

  if (!srcPath) {
    logger.info('No cookies configured, proceeding without authentication');
    return [];
  }

  if (areCookiesSuspended()) {
    logger.warn('Cookies temporarily disabled due to previous invalidation');
    return [];
  }

  // If the configured path exists and is writable, use it directly so yt-dlp can persist updates
  try {
    fs.accessSync(srcPath, fs.constants.R_OK | fs.constants.W_OK);
    logger.info('Using writable cookies file', { path: srcPath });
    return ['--cookies', srcPath];
  } catch {
    // Not writable or missing; try to seed a persistent, writable store
  }

  const storePath = process.env.COOKIES_STORE_PATH || '/data/cookies/cookies.txt';
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
  } catch {}

  try {
    if (!fs.existsSync(storePath)) {
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, storePath);
        logger.info('Seeded writable cookies store from source', { source: srcPath, store: storePath });
      } else {
        logger.warn('Configured cookies source not found; creating empty store', { source: srcPath, store: storePath });
        fs.writeFileSync(storePath, '# Netscape HTTP Cookie File\n');
      }
    }
    // Verify writability of the store path
    fs.accessSync(storePath, fs.constants.R_OK | fs.constants.W_OK);
    logger.info('Using persistent writable cookies store', { store: storePath });
    return ['--cookies', storePath];
  } catch (error) {
    logger.error('Failed to prepare writable cookies store', { error: error.message, store: storePath, source: srcPath });
    // Last resort: return original path (may be read-only; yt-dlp might not persist updates)
    if (fs.existsSync(srcPath)) {
      logger.warn('Falling back to read-only cookies path', { path: srcPath });
      return ['--cookies', srcPath];
    }
  }

  logger.info('No usable cookies file; proceeding without authentication');
  return [];
}

// Cleanup function for temporary files
function cleanupTempFiles() {
  // No-op: we use a persistent cookies store; keep method for backward compatibility
}

// Cleanup on exit
process.on('SIGTERM', cleanupTempFiles);
process.on('SIGINT', cleanupTempFiles);
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    error: reason instanceof Error ? reason.message : String(reason)
  });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'youtube-resolver',
    timestamp: new Date().toISOString(),
    cache: {
      size: searchCache.size,
      maxSize: MAX_CACHE_SIZE,
      ttl: CACHE_TTL
    }
  });
});

// Cache management endpoints
app.post('/cache/clear', (req, res) => {
  const previousSize = searchCache.size;
  searchCache.clear();
  logger.info('Cache cleared', { previousSize });
  res.json({ 
    message: 'Cache cleared successfully',
    previousSize,
    currentSize: searchCache.size
  });
});

app.get('/cache/stats', (req, res) => {
  const entries = [];
  for (const [key, value] of searchCache.entries()) {
    entries.push({
      key,
      age: Date.now() - value.timestamp,
      resultCount: value.results.length
    });
  }
  
  res.json({
    size: searchCache.size,
    maxSize: MAX_CACHE_SIZE,
    ttl: CACHE_TTL,
    entries: entries.sort((a, b) => b.age - a.age) // Most recent first
  });
});

// Search YouTube videos with quick mode fallback
app.post('/search', rateLimitByIp, async (req, res) => {
  // Validate and normalize inputs according to bot usage
  const queryRaw = req.body?.query;
  if (typeof queryRaw !== 'string' || !queryRaw.trim() || queryRaw.length > 200) {
    return res.status(400).json({ error: 'Invalid query' });
  }
  let maxResults = Number(req.body?.maxResults);
  if (!Number.isFinite(maxResults)) maxResults = 3;
  // Bot defaults to 3; allow up to 5 to keep Pi stable
  maxResults = Math.max(1, Math.min(5, Math.floor(maxResults)));
  const quickMode = typeof req.body?.quickMode === 'boolean' ? req.body.quickMode : true;
  const query = queryRaw.trim();

  logger.info('YouTube search request', { query, maxResults, quickMode });

  // Check cache first
  const cachedResults = getCachedResult(query, maxResults);
  if (cachedResults) {
    return res.json({ results: cachedResults });
  }

  try {
    let results;
    
    // Try quick search first if enabled (prefer Music client via extractor-args)
    if (quickMode) {
      try {
        results = await searchYouTubeQuickEngine('music', query, maxResults);
        if (!results || results.length === 0) {
          results = await searchYouTubeQuickEngine('default', query, maxResults);
        }
        logger.info('Quick search completed', { query, resultsCount: results.length, preferred: 'music_client' });
      } catch (quickError) {
        logger.warn('Quick search failed, falling back to normal search', { 
          query, 
          error: quickError.message 
        });
        results = await searchYouTubeEngine('music', query, maxResults, true).catch(async () => {
          return await searchYouTubeEngine('default', query, maxResults, true);
        });
      }
    } else {
      // Normal search: first try with Music client, then fallback to default clients
      results = await searchYouTubeEngine('music', query, maxResults, true).catch(async (e) => {
        // If cookies invalid handled internally, we still get results or error; propagate to fallback by returning []
        logger.warn('music_client_search_failed_or_empty', { error: e?.message });
        return [];
      });
      if (!results || results.length === 0) {
        results = await searchYouTubeEngine('default', query, maxResults, true).catch(async () => []);
      }
    }
    
    // Final defense: filter out non-video YouTube URLs from results
    const isVideoUrl = (u) => {
      try {
        const url = new URL(u);
        const host = url.hostname.toLowerCase();
        const isYt = host === 'youtu.be' || host === 'www.youtube.com' || host === 'youtube.com' || host.endsWith('.youtube.com');
        if (!isYt) return true; // Non-YouTube entries untouched here
        if (host === 'youtu.be') {
          const id = url.pathname.replace(/^\//, '');
          return id && id.length === 11;
        }
        if (url.pathname === '/watch') {
          const v = url.searchParams.get('v');
          return !!(v && v.length === 11);
        }
        // Avoid shorts in results
        if (url.pathname.startsWith('/shorts/')) return false;
        return false;
      } catch {
        return false;
      }
    };
    const preCount = results.length;
    results = results.filter(r => (r.service !== 'youtube') || isVideoUrl(r.url));
    const filteredOut = preCount - results.length;
    if (filteredOut > 0) {
      logger.info('Filtered non-video results from search', { query, preCount, filteredOut, finalCount: results.length });
    }

    // Cache the results
    setCachedResult(query, maxResults, results);
    
    res.json({ results });
  } catch (error) {
    logger.error('Search failed', { query, error: error.message });
    res.status(500).json({ error: 'Search failed', message: error.message });
  }
});

// Get stream URL for a specific video
app.post('/stream', rateLimitByIp, async (req, res) => {
  // Validate and normalize inputs according to bot usage
  const urlField = req.body?.url;
  const rawUrl = typeof urlField === 'string' ? urlField : urlField?.url;
  const proxy = typeof req.body?.proxy === 'boolean' ? req.body.proxy : false; // bot sends true
  const bypass = typeof req.body?.bypass === 'boolean' ? req.body.bypass : false;

  if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl.length > 2048) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  let videoUrl = rawUrl.trim();
  try {
    const u = new URL(videoUrl);
    const host = u.hostname.toLowerCase();
    const allowed = host === 'youtube.com' || host === 'www.youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');
    if (!allowed) {
      return res.status(400).json({ error: 'Only YouTube URLs are allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  // Only allow direct video URLs (not channels/playlists) to avoid yt-dlp failures with --no-playlist
  const isVideoUrl = (u) => {
    try {
      const url = new URL(u);
      const host = url.hostname.toLowerCase();
      const isYt = host === 'youtu.be' || host === 'www.youtube.com' || host === 'youtube.com' || host.endsWith('.youtube.com');
      if (!isYt) return false;
      if (host === 'youtu.be') {
        const id = url.pathname.replace(/^\//, '');
        return id && id.length === 11;
      }
      if (url.pathname === '/watch') {
        const v = url.searchParams.get('v');
        return !!(v && v.length === 11);
      }
      if (url.pathname.startsWith('/shorts/')) {
        const id = url.pathname.split('/')[2] || '';
        return id.length === 11;
      }
      return false;
    } catch {
      return false;
    }
  };

  if (!isVideoUrl(videoUrl)) {
    logger.warn('Rejected non-video YouTube URL for stream', { url: videoUrl });
    return res.status(400).json({ error: 'URL must be a YouTube video (watch, shorts, or youtu.be)' });
  }

  logger.info('Stream URL request', { url: videoUrl, proxy, bypass });

  try {
    const streamUrl = await getStreamUrl(videoUrl);
    if (streamUrl) {
      logger.info('Stream URL resolved', { originalUrl: videoUrl, resolved: true });
      
      if (bypass) {
        // Return direct YouTube URL (may cause 403 on VPS but good for testing)
        res.json({ streamUrl });
      } else if (proxy) {
        // Return proxy URL instead of direct YouTube URL
        const proxyUrl = `${req.protocol}://${req.get('host')}/proxy-stream?url=${encodeURIComponent(streamUrl)}`;
        res.json({ streamUrl: proxyUrl });
      } else {
        res.json({ streamUrl });
      }
    } else {
      logger.warn('Stream URL not found', { url: videoUrl });
      res.status(404).json({ error: 'Stream URL not found' });
    }
  } catch (error) {
    logger.error('Stream resolution failed', { url: videoUrl, error: error.message });
    res.status(500).json({ error: 'Stream resolution failed', message: error.message });
  }
});

// Proxy stream endpoint - handles both GET and HEAD requests
app.all('/proxy-stream', rateLimitByIp, async (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  const decodedUrl = decodeURIComponent(url);

  // Validate request method
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Destination validation (hosts/schemes and IP ranges) via env
  try {
    const ok = await isAllowedDestination(decodedUrl);
    if (!ok) {
      logger.warn('Rejected proxy-stream URL (validation failed)', { ...buildUrlLogMeta(decodedUrl), method: req.method });
      return res.status(400).json({ error: 'Invalid or disallowed URL' });
    }
  } catch (e) {
    logger.warn('Destination validation error', { ...buildUrlLogMeta(decodedUrl), error: e.message });
    return res.status(400).json({ error: 'Invalid or disallowed URL' });
  }

  // Check circuit breaker
  if (isCircuitOpen()) {
    logger.warn('Circuit breaker open, rejecting request', { ...buildUrlLogMeta(decodedUrl) });
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  // Serve HEAD requests without occupying the per-URL concurrency slot
  if (req.method === 'HEAD') {
    try {
      logger.info('Proxying HEAD', { ...buildUrlLogMeta(decodedUrl), method: req.method });
      const headResp = await axios({
        method: 'HEAD',
        url: decodedUrl,
        timeout: 15000,
        maxRedirects: 2,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36',
          'Accept': 'audio/mp4',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
        },
        httpsAgent: require('https').Agent({ keepAlive: false, maxSockets: 1, timeout: 0 }),
        httpAgent: require('http').Agent({ keepAlive: false, maxSockets: 1, timeout: 0 }),
      });
      // Pass through key headers
      if (headResp.headers['content-length']) res.set('Content-Length', headResp.headers['content-length']);
      if (headResp.headers['content-type']) res.set('Content-Type', headResp.headers['content-type']);
      if (headResp.headers['content-range']) res.set('Content-Range', headResp.headers['content-range']);
      res.set('Connection', 'close');
      return res.status(headResp.status === 206 ? 206 : 200).end();
    } catch (e) {
      logger.warn('HEAD proxy failed', { ...buildUrlLogMeta(decodedUrl), error: e.message });
      return res.status(502).json({ error: 'HEAD upstream failed' });
    }
  }

  // Check rate limiting
  if (!canMakeCall(decodedUrl)) {
    logger.warn('Per-URL concurrency limit reached, queueing request', { 
      ...buildUrlLogMeta(decodedUrl), 
      activeCalls: activeCalls.get(decodedUrl),
      queueSize: (urlQueues.get(decodedUrl) || []).length
    });
    
    // Add to queue instead of rejecting immediately
    addToUrlQueue(decodedUrl, req, res);
    return;
  }

  // Process immediately if not rate limited
  await handleProxyStreamRequest(req, res, decodedUrl);
});

// Separated function to handle the actual proxy stream logic
async function handleProxyStreamRequest(req, res, decodedUrl) {
  recordActiveCall(decodedUrl);

  try {
    logger.info('Proxying stream', { 
      ...buildUrlLogMeta(decodedUrl),
      method: req.method,
      range: req.headers.range,
      activeCalls: activeCalls.get(decodedUrl)
    });
    
    // For HEAD requests, just get headers
    const axiosMethod = req.method === 'HEAD' ? 'HEAD' : 'GET';
    const isHeadRequest = req.method === 'HEAD';
    
    const axiosConfig = {
      method: axiosMethod,
      url: decodedUrl,
      responseType: isHeadRequest ? 'text' : 'stream',
      timeout: isHeadRequest ? 15000 : 0, // No timeout for streaming, 15s for HEAD
      maxRedirects: 3, // Reduced
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36',
        'Connection': 'close', // Force close connections for Pi 3
        'Accept': 'audio/mp4',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache'
      },
      // Ultra-conservative for Pi 3 - no persistent connections
      httpsAgent: require('https').Agent({
        keepAlive: false, // Disable keepalive to save memory
        maxSockets: 1,
        timeout: 0 // No timeout for streaming - let YouTube decide
      }),
      httpAgent: require('http').Agent({
        keepAlive: false,
        maxSockets: 1,
        timeout: 0 // No timeout for streaming - let YouTube decide
      }),
      // Memory optimization
      maxContentLength: 50 * 1024 * 1024, // 50MB max
      maxBodyLength: 50 * 1024 * 1024
    };

    // Always request a range to enable resume logic; default to bytes=0-
    axiosConfig.headers['Range'] = req.headers.range || 'bytes=0-';

    const response = await axios(axiosConfig);

    // Ultra-minimalist headers for Pi 3
    res.set({
      'Content-Type': response.headers['content-type'] || 'audio/mp4',
      'Connection': 'close', // Force close to free memory
      'Cache-Control': 'no-store'
    });

    // Copy important headers from YouTube
    if (response.headers['content-length']) {
      res.set('Content-Length', response.headers['content-length']);
    }
    if (response.headers['content-range']) {
      res.set('Content-Range', response.headers['content-range']);
    }

    // Set appropriate status code
    const statusCode = response.status === 206 ? 206 : 200;
    res.status(statusCode);

    // For HEAD requests, just send headers
    if (isHeadRequest) {
      logger.info('HEAD request completed', { ...buildUrlLogMeta(decodedUrl), status: statusCode });
      return res.end();
    }

    // Ensure the server never times out our response
    if (typeof res.setTimeout === 'function') {
      res.setTimeout(0);
    }

    // Parse initial range requested by the client (default to 0-)
    function parseStartFromRange(rangeHeader) {
      if (!rangeHeader) return 0;
      const m = /bytes\s*=\s*(\d+)-/i.exec(rangeHeader);
      return m ? parseInt(m[1], 10) : 0;
    }

    function parseContentRange(header) {
      // Example: "bytes 0-1023/2048"
      if (!header) return null;
      const m = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(header);
      if (!m) return null;
      return {
        start: parseInt(m[1], 10),
        end: parseInt(m[2], 10),
        total: parseInt(m[3], 10)
      };
    }

    const clientInitialStart = parseStartFromRange(req.headers.range);

    // Determine total expected bytes from the first response
    let expectedTotalBytes = null;
    const cr = parseContentRange(response.headers['content-range']);
    if (cr) {
      expectedTotalBytes = cr.total - clientInitialStart;
    } else if (response.headers['content-length']) {
      expectedTotalBytes = parseInt(response.headers['content-length'], 10);
    }

    // We will stitch upstream chunks into a single response without ending it between attempts
    let downloadedBytes = 0;
    let retries = 0;
    const maxRetries = 6; // a few reconnections for long tracks
    let activeUpstream = null;
    let finished = false;

    // Use a small helper that starts an upstream request at a given offset
    const startUpstream = async (offset) => {
      if (finished) return;
      const startAt = clientInitialStart + offset;
      const rangeHeader = `bytes=${startAt}-`;

      const cfg = {
        ...axiosConfig,
        // Always request a specific range to enable resume
        headers: {
          ...axiosConfig.headers,
          Range: rangeHeader
        }
      };

      logger.info('Proxy upstream request', { ...buildUrlLogMeta(decodedUrl), range: rangeHeader, attempt: retries + 1 });

      const upstream = await axios(cfg);
      activeUpstream = upstream.data;

      // First attempt already set headers/status above; next attempts just append bytes
      activeUpstream.on('data', (chunk) => {
        downloadedBytes += chunk.length;
      });

      // Pipe but do not end the client response; we may need to resume
      activeUpstream.pipe(res, { end: false });

      activeUpstream.once('end', () => {
        if (finished) return;

        // If we don't know how much is expected, assume completion on end
        if (expectedTotalBytes == null || downloadedBytes >= expectedTotalBytes) {
          finished = true;
          recordSuccess();
          recordCallComplete(decodedUrl);
          logger.info('Stream proxy completed', { ...buildUrlLogMeta(decodedUrl), bytes: downloadedBytes });
          return res.end();
        }

        // Ended early without error: resume
        if (retries < maxRetries) {
          retries += 1;
          logger.warn('Upstream ended early, resuming', { ...buildUrlLogMeta(decodedUrl), downloaded: downloadedBytes, expected: expectedTotalBytes, attempt: retries });
          startUpstream(downloadedBytes).catch(handleFatalError);
        } else {
          handleFatalError(new Error('Max resume attempts reached'));
        }
      });

      activeUpstream.once('error', (error) => {
        if (finished) return;
        if (retries < maxRetries) {
          retries += 1;
          logger.error('Upstream stream error, will resume', { ...buildUrlLogMeta(decodedUrl), error: error.message, code: error.code, downloaded: downloadedBytes, attempt: retries });
          // Slight delay before retry to avoid hammering
          setTimeout(() => startUpstream(downloadedBytes).catch(handleFatalError), 250);
        } else {
          handleFatalError(error);
        }
      });

      // If client disconnects, stop fetching
      res.req.once('close', () => {
        if (finished) return;
        finished = true;
        try { activeUpstream.destroy && activeUpstream.destroy(); } catch {}
        recordCallComplete(decodedUrl);
        logger.warn('Client disconnected from stream', { ...buildUrlLogMeta(decodedUrl) });
      });
    };

    const handleFatalError = (error) => {
      if (finished) return;
      finished = true;
      recordFailure();
      recordCallComplete(decodedUrl);
      logger.error('Stream proxy error', { error: error.message, code: error.code, ...buildUrlLogMeta(decodedUrl) });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream proxy failed' });
      } else {
        try { res.end(); } catch {}
      }
    };

    // For the very first upstream we already fetched one response above. Use it and then switch to resume logic if needed
    // Attach counters and forward data without ending the client response
    response.data.on('data', (chunk) => {
      downloadedBytes += chunk.length;
    });
    response.data.pipe(res, { end: false });

    const onInitialEnd = () => {
      if (finished) return;
      if (expectedTotalBytes == null || downloadedBytes >= expectedTotalBytes) {
        finished = true;
        recordSuccess();
        recordCallComplete(decodedUrl);
        logger.info('Stream proxy completed', { ...buildUrlLogMeta(decodedUrl), bytes: downloadedBytes });
        return res.end();
      }
      // Resume from where we left off
      if (retries < maxRetries) {
        retries += 1;
        logger.warn('Initial upstream ended early, resuming', { ...buildUrlLogMeta(decodedUrl), downloaded: downloadedBytes, expected: expectedTotalBytes, attempt: retries });
        startUpstream(downloadedBytes).catch(handleFatalError);
      } else {
        handleFatalError(new Error('Max resume attempts reached'));
      }
    };

    const onInitialError = (error) => {
      if (finished) return;
      if (retries < maxRetries) {
        retries += 1;
        logger.error('Initial upstream error, will resume', { ...buildUrlLogMeta(decodedUrl), error: error.message, code: error.code, downloaded: downloadedBytes, attempt: retries });
        setTimeout(() => startUpstream(downloadedBytes).catch(handleFatalError), 250);
      } else {
        handleFatalError(error);
      }
    };

    response.data.once('end', onInitialEnd);
    response.data.once('error', onInitialError);
    response.data.once('close', () => {
      // close may be followed by end/error; nothing to do here specifically
    });

    // Handle client disconnect on the initial stream
    req.on('close', () => {
      if (finished) return;
      finished = true;
      try { response.data && response.data.destroy && response.data.destroy(); } catch {}
      recordCallComplete(decodedUrl);
      logger.warn('Client disconnected from stream', { ...buildUrlLogMeta(decodedUrl) });
    });

    req.on('aborted', () => {
      if (finished) return;
      finished = true;
      try { response.data && response.data.destroy && response.data.destroy(); } catch {}
      recordCallComplete(decodedUrl);
      logger.warn('Client aborted stream', { ...buildUrlLogMeta(decodedUrl) });
    });

  } catch (error) {
    recordFailure();
    recordCallComplete(decodedUrl);
    
    logger.error('Stream proxy failed', { ...buildUrlLogMeta(decodedUrl), error: error.message, code: error.code });
    
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream proxy failed' });
    }
  } finally {
    // Process next queued request for this URL
    processUrlQueue(decodedUrl);
  }
}

// ===============
// Security helpers
// ===============

function parseAllowedList(envName, fallback = '') {
  return (process.env[envName] || fallback)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function isPrivateIp(ip) {
  // IPv4 private and loopback ranges
  if (net.isIP(ip) === 4) {
    if (ip === '127.0.0.1') return true;
    if (ip.startsWith('10.')) return true;
    if (ip.startsWith('192.168.')) return true;
    // 172.16.0.0 – 172.31.255.255
    const parts = ip.split('.').map(n => parseInt(n, 10));
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  }
  // IPv6 loopback/link-local/unique-local
  if (ip === '::1') return true;
  if (ip.toLowerCase().startsWith('fe80:')) return true; // link-local
  if (ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd')) return true; // unique local
  return false;
}

function ipToInt(ip) {
  const parts = ip.split('.').map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function ipInCidr(ip, cidr) {
  // IPv4-only CIDR check (e.g., 1.2.3.0/24). IPv6 not supported here.
  const [netAddr, maskBitsStr] = cidr.split('/');
  const maskBits = parseInt(maskBitsStr, 10);
  const ipInt = ipToInt(ip);
  const netInt = ipToInt(netAddr);
  if (ipInt == null || netInt == null) return false;
  if (Number.isNaN(maskBits) || maskBits < 0 || maskBits > 32) return false;
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

async function isAllowedDestination(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }

  // Schemes allowed (default https only)
  const allowedSchemes = resolverConfig.allowedDestSchemes;
  if (!allowedSchemes.includes(u.protocol.replace(':', ''))) return false;

  const host = u.hostname.toLowerCase();
  const allowedHostSuffixes = resolverConfig.allowedDestHostSuffixes;
  const hostAllowed = allowedHostSuffixes.some(suf => host === suf || host.endsWith(`.${suf}`));
  if (!hostAllowed) return false;

  // Resolve DNS and check IPs
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length) return false;

  // If ALLOWED_DEST_CIDRS is provided, only allow IPs that fall in at least one CIDR
  const allowedCidrs = resolverConfig.allowedDestCidrs;
  if (allowedCidrs.length > 0) {
    const ok = addrs.some(a => net.isIP(a.address) === 4 && allowedCidrs.some(c => ipInCidr(a.address, c)));
    return ok;
  }

  // Default: block private ranges, allow public
  return addrs.every(a => !isPrivateIp(a.address));
}

// Quick search YouTube using minimal yt-dlp options for faster results
function searchYouTubeQuick(query, maxResults) {
  return new Promise((resolve, reject) => {
    const searchQuery = `ytsearch${maxResults}:${query}`;
    
    // Optimized args for maximum speed (re-added --flat-playlist for testing)
    const ytDlpArgs = [
      '--dump-json',
      '--default-search', 'ytsearch',
      '--no-playlist',
      '--no-check-certificate',
      '--geo-bypass',
      '--skip-download',
      '--quiet',
      '--ignore-errors',
      '--socket-timeout', '20',  // Increased for Raspberry Pi
      '--max-downloads', maxResults.toString()
    ];

    // Only add cookies for quick search if specifically enabled
    if (resolverConfig.quickSearchCookies) {
      ytDlpArgs.push(...getCookieArgs());
    }

    ytDlpArgs.push(searchQuery);

    logger.info('Executing yt-dlp quick search', { command: 'yt-dlp', args: ytDlpArgs });

    const ytDlp = spawn('yt-dlp', ytDlpArgs);
    let output = '';
    let errorOutput = '';
    let isTimedOut = false;

    // Shorter timeout for quick mode - adjusted for Raspberry Pi
    const timeoutId = setTimeout(() => {
      isTimedOut = true;
      ytDlp.kill('SIGKILL');
      logger.warn('yt-dlp quick search timed out', { query, timeout: 30000 });
    }, 30000);

    ytDlp.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytDlp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ytDlp.on('close', (code) => {
      clearTimeout(timeoutId);
      
      if (isTimedOut) {
        reject(new Error('Quick search timed out after 30 seconds'));
        return;
      }

      if (code !== 0) {
        logger.error('yt-dlp quick search failed', { exitCode: code, error: errorOutput });
        reject(new Error(errorOutput || `yt-dlp quick search exited with code ${code}`));
        return;
      }

      const results = [];
      const lines = output.trim().split('\n');

      // Helper: validate candidate is a YouTube VIDEO url (not channel/playlist)
      const isVideoUrl = (u) => {
        try {
          const url = new URL(u);
          const host = url.hostname.toLowerCase();
          const isYt = host === 'youtu.be' || host === 'www.youtube.com' || host === 'youtube.com' || host.endsWith('.youtube.com');
          if (!isYt) return false;
          if (host === 'youtu.be') {
            const id = url.pathname.replace(/^\//, '');
            return id && id.length === 11;
          }
          if (url.pathname === '/watch') {
            const v = url.searchParams.get('v');
            return !!(v && v.length === 11);
          }
          // Avoid shorts
          if (url.pathname.startsWith('/shorts/')) return false;
          return false;
        } catch {
          return false;
        }
      };

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const videoData = JSON.parse(line);
          
          if (videoData?.id && videoData?.title) {
            const candidateUrl = videoData.webpage_url || videoData.url || `https://www.youtube.com/watch?v=${videoData.id}`;
            if (!isVideoUrl(candidateUrl)) {
              // Skip channels/playlists or non-video entries
              continue;
            }
            results.push({
              title: videoData.title,
              creator: videoData.uploader || 'Unknown Artist',
              duration: videoData.duration || 0,
              url: candidateUrl,
              thumbnail: videoData.thumbnail || '',
              service: 'youtube'
            });
          }
        } catch (parseError) {
          logger.warn('Failed to parse yt-dlp quick search JSON output', { 
            error: parseError.message,
            line: line.substring(0, 100)
          });
          continue;
        }
      }

      resolve(results);
    });

    ytDlp.on('error', (error) => {
      clearTimeout(timeoutId);
      logger.error('yt-dlp quick search process error', { error: error.message });
      reject(error);
    });
  });
}

// Search YouTube using yt-dlp with cookies file and performance optimizations
function searchYouTube(query, maxResults) {
  return new Promise((resolve, reject) => {
    const searchQuery = `ytsearch${maxResults}:${query}`;
    
    const ytDlpArgs = [
      '--dump-json',
      '--default-search', 'ytsearch',
      '--no-playlist',
      '--no-check-certificate',
      '--geo-bypass',
      '--skip-download',
      '--ignore-errors',
      '--socket-timeout', '30',  // Increased for Raspberry Pi
      '--playlist-end', maxResults.toString(),
      ...getCookieArgs(),  // Add cookies if available
      searchQuery
    ];

    logger.info('Executing yt-dlp search', { command: 'yt-dlp', args: ytDlpArgs });

    const ytDlp = spawn('yt-dlp', ytDlpArgs, {
      timeout: 25000  // Kill process after 25 seconds
    });
    let output = '';
    let errorOutput = '';
    let isTimedOut = false;

    // Add explicit timeout handling - increased for Raspberry Pi
    const timeoutId = setTimeout(() => {
      isTimedOut = true;
      ytDlp.kill('SIGKILL');
      logger.warn('yt-dlp search timed out', { query, timeout: 45000 });
    }, 45000);

    ytDlp.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytDlp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ytDlp.on('close', (code) => {
      clearTimeout(timeoutId);
      
      if (isTimedOut) {
        reject(new Error('Search timed out after 45 seconds'));
        return;
      }

      if (code !== 0) {
        logger.error('yt-dlp search failed', { exitCode: code, error: errorOutput });
        reject(new Error(errorOutput || `yt-dlp exited with code ${code}`));
        return;
      }

      const results = [];
      const lines = output.trim().split('\n');

      // Helper: validate candidate is a YouTube VIDEO url (not channel/playlist)
      const isVideoUrl = (u) => {
        try {
          const url = new URL(u);
          const host = url.hostname.toLowerCase();
          const isYt = host === 'youtu.be' || host === 'www.youtube.com' || host === 'youtube.com' || host.endsWith('.youtube.com');
          if (!isYt) return false;
          if (host === 'youtu.be') {
            const id = url.pathname.replace(/^\//, '');
            return id && id.length === 11;
          }
          if (url.pathname === '/watch') {
            const v = url.searchParams.get('v');
            return !!(v && v.length === 11);
          }
          if (url.pathname.startsWith('/shorts/')) {
            const id = url.pathname.split('/')[2] || '';
            return id.length === 11;
          }
          return false;
        } catch {
          return false;
        }
      };

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const videoData = JSON.parse(line);
          
          if (videoData?.id && videoData?.title) {
            const candidateUrl = videoData.webpage_url || videoData.url || `https://www.youtube.com/watch?v=${videoData.id}`;
            if (!isVideoUrl(candidateUrl)) {
              // Skip channels/playlists or non-video entries
              continue;
            }
            results.push({
              title: videoData.title,
              creator: videoData.uploader || 'Unknown Artist',
              duration: videoData.duration || 0,
              url: candidateUrl,
              thumbnail: videoData.thumbnail || '',
              service: 'youtube'
            });
          }
        } catch (parseError) {
          // Skip malformed JSON lines - log for debugging
          logger.warn('Failed to parse yt-dlp JSON output', { 
            error: parseError.message,
            line: line.substring(0, 100)
          });
          continue;
        }
      }

      resolve(results);
    });

    ytDlp.on('error', (error) => {
      logger.error('yt-dlp process error', { error: error.message });
      reject(error);
    });
  });
}

// Prefer YouTube Music or YouTube explicitly for quick mode
function searchYouTubeQuickEngine(engine, query, maxResults, useCookies = resolverConfig.quickSearchCookies) {
  return new Promise((resolve, reject) => {
    const searchQuery = `ytsearch${maxResults}:${query}`;
    
    // Optimized args for speed
    const ytDlpArgs = [
      '--dump-json',
      '--default-search', 'ytsearch',
      '--no-playlist',
      '--no-check-certificate',
      '--geo-bypass',
      '--skip-download',
      '--quiet',
      '--ignore-errors',
      '--socket-timeout', String(resolverConfig.ytdlpSocketTimeoutSec || 20),
      '--max-downloads', maxResults.toString(),
      searchQuery
    ];

    // Prefer Music client on first attempt via extractor-args
    if (engine === 'music') {
      ytDlpArgs.splice(-1, 0, '--extractor-args', 'youtube:player_client=web_music,web');
    }

    if (useCookies && !areCookiesSuspended()) {
      ytDlpArgs.splice(-1, 0, ...getCookieArgs());
    }

    logger.info('Executing yt-dlp quick search', { command: 'yt-dlp', engine, args: ytDlpArgs });

    const ytDlp = spawn('yt-dlp', ytDlpArgs);
    let output = '';
    let errorOutput = '';
    let isTimedOut = false;

    const timeoutId = setTimeout(() => {
      isTimedOut = true;
      ytDlp.kill('SIGKILL');
      logger.warn('yt-dlp quick search timed out', { query, timeout: resolverConfig.searchQuickTimeoutMs || 30000, engine });
    }, resolverConfig.searchQuickTimeoutMs || 30000);

    ytDlp.stdout.on('data', (data) => { output += data.toString(); });
    ytDlp.stderr.on('data', (data) => { errorOutput += data.toString(); });

    ytDlp.on('close', async (code) => {
      clearTimeout(timeoutId);
      if (isTimedOut) return reject(new Error('Quick search timed out after 30 seconds'));
      if (code !== 0) {
        // If cookies invalid, retry once without cookies and suspend
        if (useCookies && containsInvalidCookiesError(errorOutput)) {
          suspendCookiesFor(15 * 60 * 1000); // 15 minutes
          logger.warn('Retrying quick search without cookies after invalidation', { query });
          try {
            const res = await searchYouTubeQuickEngine(engine, query, maxResults, false);
            return resolve(res);
          } catch (e) {
            return reject(e);
          }
        }
        logger.error('yt-dlp quick search failed', { exitCode: code, error: errorOutput, engine });
        return reject(new Error(errorOutput || `yt-dlp quick search exited with code ${code}`));
      }

      const results = [];
      const lines = output.trim().split('\n');
      const isVideoUrl = (u) => {
        try {
          const url = new URL(u);
          const host = url.hostname.toLowerCase();
          const isYt = host === 'youtu.be' || host === 'www.youtube.com' || host === 'youtube.com' || host.endsWith('.youtube.com');
          if (!isYt) return false;
          if (host === 'youtu.be') {
            const id = url.pathname.replace(/^\//, '');
            return id && id.length === 11;
          }
          if (url.pathname === '/watch') {
            const v = url.searchParams.get('v');
            return !!(v && v.length === 11);
          }
          if (url.pathname.startsWith('/shorts/')) return false;
          return false;
        } catch { return false; }
      };

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const videoData = JSON.parse(line);
          if (videoData?.id && videoData?.title) {
            const candidateUrl = videoData.webpage_url || videoData.url || `https://www.youtube.com/watch?v=${videoData.id}`;
            if (!isVideoUrl(candidateUrl)) continue;
            results.push({
              title: videoData.title,
              creator: videoData.uploader || 'Unknown Artist',
              duration: videoData.duration || 0,
              url: candidateUrl,
              thumbnail: videoData.thumbnail || '',
              service: 'youtube'
            });
          }
        } catch (parseError) {
          logger.warn('Failed to parse yt-dlp quick search JSON output', { error: parseError.message, line: line.substring(0, 100) });
          continue;
        }
      }

      resolve(results);
    });

    ytDlp.on('error', (error) => {
      clearTimeout(timeoutId);
      logger.error('yt-dlp quick search process error', { error: error.message, engine });
      reject(error);
    });
  });
}

// Prefer YouTube Music or YouTube explicitly for normal mode
function searchYouTubeEngine(engine, query, maxResults, useCookies = true) {
  return new Promise((resolve, reject) => {
    const searchQuery = `ytsearch${maxResults}:${query}`;
    
    const ytDlpArgs = [
      '--dump-json',
      '--default-search', 'ytsearch',
      '--no-playlist',
      '--no-check-certificate',
      '--geo-bypass',
      '--skip-download',
      '--ignore-errors',
      '--socket-timeout', String(resolverConfig.ytdlpSocketTimeoutSec || 30),
      '--playlist-end', maxResults.toString(),
      // Attach cookies only when enabled and not suspended
      ...(useCookies && !areCookiesSuspended() ? getCookieArgs() : []),
      searchQuery
    ];

    // First pass can prefer web_music client; fallback uses default clients
    if (engine === 'music') {
      ytDlpArgs.splice(-1, 0, '--extractor-args', 'youtube:player_client=web_music,web');
    } else if (engine === 'default') {
      // Being explicit helps debugging; this is equivalent to yt-dlp defaults
      ytDlpArgs.splice(-1, 0, '--extractor-args', 'youtube:player_client=default');
    }

    logger.info('Executing yt-dlp search', { command: 'yt-dlp', engine, args: ytDlpArgs });

    const ytDlp = spawn('yt-dlp', ytDlpArgs); // Let our own timeout control lifecycle
    let output = '';
    let errorOutput = '';
    let isTimedOut = false;

    const timeoutId = setTimeout(() => {
      isTimedOut = true;
      ytDlp.kill('SIGKILL');
      logger.warn('yt-dlp search timed out', { query, timeout: resolverConfig.searchTimeoutMs || 45000, engine });
    }, resolverConfig.searchTimeoutMs || 45000);

    ytDlp.stdout.on('data', (data) => { output += data.toString(); });
    ytDlp.stderr.on('data', (data) => { errorOutput += data.toString(); });

    ytDlp.on('close', async (code) => {
      clearTimeout(timeoutId);
      if (isTimedOut) return reject(new Error('Search timed out after 45 seconds'));
      if (code !== 0) {
        // Handle invalid cookies: retry once without cookies and suspend further cookie use
        if (useCookies && containsInvalidCookiesError(errorOutput)) {
          suspendCookiesFor(30 * 60 * 1000); // 30 minutes suspension
          logger.warn('Retrying search without cookies after invalidation', { query, engine });
          try {
            const res = await searchYouTubeEngine(engine, query, maxResults, false);
            return resolve(res);
          } catch (e) {
            return reject(e);
          }
        }
        logger.error('yt-dlp search failed', { exitCode: code, error: errorOutput, engine });
        return reject(new Error(errorOutput || `yt-dlp exited with code ${code}`));
      }

      const results = [];
      const lines = output.trim().split('\n');
      const isVideoUrl = (u) => {
        try {
          const url = new URL(u);
          const host = url.hostname.toLowerCase();
          const isYt = host === 'youtu.be' || host === 'www.youtube.com' || host === 'youtube.com' || host.endsWith('.youtube.com');
          if (!isYt) return false;
          if (host === 'youtu.be') {
            const id = url.pathname.replace(/^\//, '');
            return id && id.length === 11;
          }
          if (url.pathname === '/watch') {
            const v = url.searchParams.get('v');
            return !!(v && v.length === 11);
          }
          if (url.pathname.startsWith('/shorts/')) return false;
          return false;
        } catch { return false; }
      };

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const videoData = JSON.parse(line);
          if (videoData?.id && videoData?.title) {
            const candidateUrl = videoData.webpage_url || videoData.url || `https://www.youtube.com/watch?v=${videoData.id}`;
            if (!isVideoUrl(candidateUrl)) continue;
            results.push({
              title: videoData.title,
              creator: videoData.uploader || 'Unknown Artist',
              duration: videoData.duration || 0,
              url: candidateUrl,
              thumbnail: videoData.thumbnail || '',
              service: 'youtube'
            });
          }
        } catch (parseError) {
          logger.warn('Failed to parse yt-dlp JSON output', { error: parseError.message, line: line.substring(0, 100) });
          continue;
        }
      }

      resolve(results);
    });

    ytDlp.on('error', (error) => {
      logger.error('yt-dlp process error', { error: error.message, engine });
      reject(error);
    });
  });
}

// Get stream URL using yt-dlp with cookies file
function getStreamUrl(videoUrl) {
  const run = (useCookies = true) => new Promise((resolve, reject) => {
    const ytDlpArgs = [
      '--get-url',
      '--format', 'bestaudio[ext=m4a]/bestaudio/best',
      '--no-playlist',
      '--socket-timeout', String(resolverConfig.ytdlpSocketTimeoutSec || 45),
      ...(useCookies && !areCookiesSuspended() ? getCookieArgs() : []),
      videoUrl
    ];

    logger.info('Executing yt-dlp stream', { command: 'yt-dlp', args: ytDlpArgs });

    const ytDlp = spawn('yt-dlp', ytDlpArgs);
    let output = '';
    let errorOutput = '';
    let isTimedOut = false;

    // Add timeout for stream resolution - Raspberry Pi needs more time
    const timeoutId = setTimeout(() => {
      isTimedOut = true;
      ytDlp.kill('SIGKILL');
      logger.warn('yt-dlp stream timed out', { videoUrl, timeout: resolverConfig.streamTimeoutMs || 90000 });
    }, resolverConfig.streamTimeoutMs || 90000);

    ytDlp.stdout.on('data', (data) => { output += data.toString(); });
    ytDlp.stderr.on('data', (data) => { errorOutput += data.toString(); });

    ytDlp.on('close', async (code) => {
      clearTimeout(timeoutId);
      
      if (isTimedOut) return reject(new Error('Stream resolution timed out after 90 seconds'));

      if (code !== 0) {
        if (useCookies && containsInvalidCookiesError(errorOutput)) {
          suspendCookiesFor(30 * 60 * 1000);
          logger.warn('Retrying stream without cookies after invalidation');
          try { return resolve(await run(false)); } catch (e) { return reject(e); }
        }
        logger.error('yt-dlp stream failed', { exitCode: code, error: errorOutput });
        return reject(new Error(errorOutput || `yt-dlp exited with code ${code}`));
      }

      const streamUrl = output.trim().split('\n')[0];
      if (streamUrl?.startsWith('http')) return resolve(streamUrl);
      return resolve(null);
    });

    ytDlp.on('error', (error) => {
      logger.error('yt-dlp stream process error', { error: error.message });
      reject(error);
    });
  });

  return run(true);
}

app.listen(port, () => {
  logger.info('YouTube Resolver API started', { 
    port,
    cacheEnabled: true,
    cacheTTL: CACHE_TTL,
    maxCacheSize: MAX_CACHE_SIZE,
    quickSearchEnabled: true,
    rateLimit: {
      windowMs: resolverConfig.rateLimitWindowMs,
      max: resolverConfig.rateLimitMax,
      burst: resolverConfig.rateLimitBurst
    },
    trustProxy: resolverConfig.trustProxy,
    logMaxSizeMB: resolverConfig.logMaxSizeMB,
    logMaxFiles: resolverConfig.logMaxFiles
  });
  console.log(`🎵 YouTube Resolver API running on port ${port}`);
  console.log(`🔍 Search: POST http://localhost:${port}/search`);
  console.log(`🎬 Stream: POST http://localhost:${port}/stream`);
  console.log(`❤️ Health: GET http://localhost:${port}/health`);
  console.log(`🗄️ Cache Stats: GET http://localhost:${port}/cache/stats`);
  console.log(`🧹 Clear Cache: POST http://localhost:${port}/cache/clear`);
  console.log(`⚡ Performance optimizations enabled for Raspberry Pi`);
});
// =====================
// Simple IP rate limiter
// =====================
const ipBuckets = new Map(); // ip -> { tokens, last }
const RL_WINDOW = resolverConfig.rateLimitWindowMs;
const RL_MAX = resolverConfig.rateLimitMax;
const RL_BURST = resolverConfig.rateLimitBurst; // bucket capacity
const RL_REFILL_PER_MS = RL_MAX / RL_WINDOW; // average allowed per ms

function rateLimitByIp(req, res, next) {
  // Disable if misconfigured
  if (!RL_MAX || RL_MAX <= 0) return next();
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  let b = ipBuckets.get(ip);
  if (!b) {
    b = { tokens: RL_BURST, last: now };
    ipBuckets.set(ip, b);
  } else {
    const elapsed = now - b.last;
    if (elapsed > 0) {
      b.tokens = Math.min(RL_BURST, b.tokens + elapsed * RL_REFILL_PER_MS);
      b.last = now;
    }
  }
  if (b.tokens < 1) {
    res.set('Retry-After', '1');
    logger.warn('IP rate limit exceeded', { ip, path: req.path });
    return res.status(429).json({ error: 'Too many requests' });
  }
  b.tokens -= 1;
  return next();
}

// Periodic housekeeping to avoid unbounded Map growth
const HOUSEKEEP_INTERVAL = Math.max(60_000, RL_WINDOW);
const hkTimer = setInterval(() => {
  const now = Date.now();
  // Prune rate limiter buckets inactive for > 2 * window
  for (const [ip, bucket] of ipBuckets.entries()) {
    if (now - bucket.last > RL_WINDOW * 2) {
      ipBuckets.delete(ip);
    }
  }
  // Prune URL queues with no pending entries
  for (const [url, queue] of urlQueues.entries()) {
    if (!queue || queue.length === 0) {
      urlQueues.delete(url);
    }
  }
}, HOUSEKEEP_INTERVAL);
// Do not keep the event loop alive for housekeeping only
if (typeof hkTimer.unref === 'function') hkTimer.unref();
