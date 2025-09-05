const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const winston = require('winston');

const app = express();
const port = process.env.PORT || 3001;

// Simple in-memory cache for search results
const searchCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_SIZE = 100; // Maximum cache entries

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
  const { url } = req.body;
  
  // Extract URL from MusicSource object if needed
  const videoUrl = typeof url === 'string' ? url : url?.url;
  
  if (!videoUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  logger.info('Stream URL request', { url: videoUrl });

  try {
    const streamUrl = await getStreamUrl(videoUrl);
    if (streamUrl) {
      logger.info('Stream URL resolved', { originalUrl: videoUrl, resolved: true });
      res.json({ streamUrl });
    } else {
      logger.warn('Stream URL not found', { url: videoUrl });
      res.status(404).json({ error: 'Stream URL not found' });
    }
  } catch (error) {
    logger.error('Stream resolution failed', { url: videoUrl, error: error.message });
    res.status(500).json({ error: 'Stream resolution failed', message: error.message });
  }
});

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
      ...getCookieArgs(),  // Add cookies if available
      videoUrl
    ];

    logger.info('Executing yt-dlp stream', { command: 'yt-dlp', args: ytDlpArgs });

    const ytDlp = spawn('yt-dlp', ytDlpArgs);
    let output = '';
    let errorOutput = '';

    ytDlp.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytDlp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ytDlp.on('close', (code) => {
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
