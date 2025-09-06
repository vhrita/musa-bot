const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const winston = require('winston');
const axios = require('axios');

// Force garbage collection for Pi 3 memory management
if (global.gc) {
  setInterval(() => {
    global.gc();
  }, 30000); // Every 30 seconds
}

const app = express();
const port = process.env.PORT || 3001;

// Ultra-minimal cache for Pi 3
const searchCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes (reduced)
const MAX_CACHE_SIZE = 20; // Reduced cache for Pi 3

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
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'resolver.log' })
  ]
});

app.use(cors());
app.use(express.json());

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
  
  logger.info('Request queued', { url, queueSize: queue.length });
  
  // Set timeout to reject old requests
  setTimeout(() => {
    const index = queue.findIndex(item => item.req === req);
    if (index !== -1) {
      queue.splice(index, 1);
      if (!res.headersSent) {
        res.status(408).json({ error: 'Request timeout - too many concurrent requests' });
      }
    }
  }, 30000); // 30 second timeout
}

function processUrlQueue(url) {
  const queue = urlQueues.get(url);
  if (!queue || queue.length === 0) {
    return;
  }
  
  if (canMakeCall(url)) {
    const { req, res } = queue.shift();
    if (!res.headersSent) {
      // Continue processing this request
      handleProxyStreamRequest(req, res, url);
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
  const cookiesPath = process.env.YTDLP_COOKIES_PATH || process.env.YTDLP_COOKIES;
  
  if (cookiesPath) {
    // Check if file exists
    const fs = require('fs');
    if (fs.existsSync(cookiesPath)) {
      // Copy cookies to a writable location (yt-dlp needs write access)
      const tempCookiesPath = '/tmp/cookies.txt';
      try {
        fs.copyFileSync(cookiesPath, tempCookiesPath);
        logger.info('Using cookies file (copied to writable location)', { 
          original: cookiesPath,
          temp: tempCookiesPath 
        });
        return ['--cookies', tempCookiesPath];
      } catch (error) {
        logger.error('Failed to copy cookies file', { 
          error: error.message,
          path: cookiesPath 
        });
        // Fallback: try to use original path with --no-cookies-from-browser
        return ['--cookies', cookiesPath, '--no-cookies-save'];
      }
    } else {
      logger.warn('Cookies file not found', { path: cookiesPath });
    }
  }
  
  // Fallback: no cookies
  logger.info('No cookies configured, proceeding without authentication');
  return [];
}

// Cleanup function for temporary files
function cleanupTempFiles() {
  const fs = require('fs');
  try {
    if (fs.existsSync('/tmp/cookies.txt')) {
      fs.unlinkSync('/tmp/cookies.txt');
      logger.info('Cleaned up temporary cookies file');
    }
  } catch (error) {
    logger.warn('Failed to cleanup temp cookies', { error: error.message });
  }
}

// Cleanup on exit
process.on('SIGTERM', cleanupTempFiles);
process.on('SIGINT', cleanupTempFiles);

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
app.post('/search', async (req, res) => {
  const { query, maxResults = 3, quickMode = true } = req.body;
  
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  logger.info('YouTube search request', { query, maxResults, quickMode });

  // Check cache first
  const cachedResults = getCachedResult(query, maxResults);
  if (cachedResults) {
    return res.json({ results: cachedResults });
  }

  try {
    let results;
    
    // Try quick search first if enabled
    if (quickMode) {
      try {
        results = await searchYouTubeQuick(query, maxResults);
        logger.info('Quick search completed successfully', { query, resultsCount: results.length });
      } catch (quickError) {
        logger.warn('Quick search failed, falling back to normal search', { 
          query, 
          error: quickError.message 
        });
        results = await searchYouTube(query, maxResults);
      }
    } else {
      results = await searchYouTube(query, maxResults);
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
app.post('/stream', async (req, res) => {
  const { url, proxy = false, bypass = false } = req.body;
  
  // Extract URL from MusicSource object if needed
  const videoUrl = typeof url === 'string' ? url : url?.url;
  
  if (!videoUrl) {
    return res.status(400).json({ error: 'URL is required' });
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
app.all('/proxy-stream', async (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  const decodedUrl = decodeURIComponent(url);

  // Check circuit breaker
  if (isCircuitOpen()) {
    logger.warn('Circuit breaker open, rejecting request', { url: decodedUrl });
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  // Check rate limiting
  if (!canMakeCall(decodedUrl)) {
    logger.warn('Rate limit exceeded, queueing request', { 
      url: decodedUrl, 
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
      originalUrl: decodedUrl, 
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

    // Add range header for partial content requests
    if (req.headers.range) {
      axiosConfig.headers['Range'] = req.headers.range;
    }

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
      logger.info('HEAD request completed', { url: decodedUrl, status: statusCode });
      return res.end();
    }

    // Ultra-simple streaming for Pi 3 - no heartbeat, direct pipe
    response.data.pipe(res);

    let streamEnded = false;

    response.data.on('error', (error) => {
      if (!streamEnded) {
        streamEnded = true;
        recordFailure();
        recordCallComplete(decodedUrl);
        logger.error('Stream proxy error', { 
          error: error.message, 
          code: error.code,
          url: decodedUrl
        });
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream proxy failed' });
        }
      }
    });

    response.data.on('end', () => {
      if (!streamEnded) {
        streamEnded = true;
        recordSuccess();
        recordCallComplete(decodedUrl);
        logger.info('Stream proxy completed', { url: decodedUrl });
      }
    });

    response.data.on('close', () => {
      if (!streamEnded) {
        streamEnded = true;
        recordCallComplete(decodedUrl);
        logger.info('Stream proxy closed', { url: decodedUrl });
      }
    });

    // Handle client disconnect
    req.on('close', () => {
      if (!streamEnded) {
        streamEnded = true;
        recordCallComplete(decodedUrl);
        logger.warn('Client disconnected from stream', { url: decodedUrl });
        if (response.data && typeof response.data.destroy === 'function') {
          response.data.destroy();
        }
      }
    });

    req.on('aborted', () => {
      if (!streamEnded) {
        streamEnded = true;
        recordCallComplete(decodedUrl);
        logger.warn('Client aborted stream', { url: decodedUrl });
        if (response.data && typeof response.data.destroy === 'function') {
          response.data.destroy();
        }
      }
    });

  } catch (error) {
    recordFailure();
    recordCallComplete(decodedUrl);
    
    logger.error('Stream proxy failed', {
      url: decodedUrl, 
      error: error.message, 
      code: error.code
    });
    
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream proxy failed' });
    }
  } finally {
    // Process next queued request for this URL
    processUrlQueue(decodedUrl);
  }
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
      '--flat-playlist',        // Re-added - excellent for speed
      '--skip-download',
      '--quiet',
      '--ignore-errors',
      '--socket-timeout', '20',  // Increased for Raspberry Pi
      '--max-downloads', maxResults.toString()
    ];

    // Only add cookies for quick search if specifically enabled
    if (process.env.QUICK_SEARCH_COOKIES === 'true') {
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

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const videoData = JSON.parse(line);
          
          if (videoData?.id && videoData?.title) {
            results.push({
              title: videoData.title,
              creator: videoData.uploader || 'Unknown Artist',
              duration: videoData.duration || 0,
              url: videoData.webpage_url || `https://www.youtube.com/watch?v=${videoData.id}`,
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

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const videoData = JSON.parse(line);
          
          if (videoData?.id && videoData?.title) {
            results.push({
              title: videoData.title,
              creator: videoData.uploader || 'Unknown Artist',
              duration: videoData.duration || 0,
              url: videoData.webpage_url || `https://www.youtube.com/watch?v=${videoData.id}`,
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

// Get stream URL using yt-dlp with cookies file
function getStreamUrl(videoUrl) {
  return new Promise((resolve, reject) => {
    const ytDlpArgs = [
      '--get-url',
      '--format', 'bestaudio[ext=m4a]/bestaudio/best',
      '--no-playlist',
      '--socket-timeout', '90',  // Increased timeout for stream resolution
      ...getCookieArgs(),  // Add cookies if available
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
      logger.warn('yt-dlp stream timed out', { videoUrl, timeout: 90000 });
    }, 90000);  // 90 seconds for stream resolution

    ytDlp.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytDlp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ytDlp.on('close', (code) => {
      clearTimeout(timeoutId);
      
      if (isTimedOut) {
        reject(new Error('Stream resolution timed out after 90 seconds'));
        return;
      }

      if (code !== 0) {
        logger.error('yt-dlp stream failed', { exitCode: code, error: errorOutput });
        reject(new Error(errorOutput || `yt-dlp exited with code ${code}`));
        return;
      }

      const streamUrl = output.trim().split('\n')[0];
      if (streamUrl?.startsWith('http')) {
        resolve(streamUrl);
      } else {
        resolve(null);
      }
    });

    ytDlp.on('error', (error) => {
      logger.error('yt-dlp stream process error', { error: error.message });
      reject(error);
    });
  });
}

app.listen(port, () => {
  logger.info('YouTube Resolver API started', { 
    port,
    cacheEnabled: true,
    cacheTTL: CACHE_TTL,
    maxCacheSize: MAX_CACHE_SIZE,
    quickSearchEnabled: true
  });
  console.log(`🎵 YouTube Resolver API running on port ${port}`);
  console.log(`🔍 Search: POST http://localhost:${port}/search`);
  console.log(`🎬 Stream: POST http://localhost:${port}/stream`);
  console.log(`❤️ Health: GET http://localhost:${port}/health`);
  console.log(`🗄️ Cache Stats: GET http://localhost:${port}/cache/stats`);
  console.log(`🧹 Clear Cache: POST http://localhost:${port}/cache/clear`);
  console.log(`⚡ Performance optimizations enabled for Raspberry Pi`);
});
