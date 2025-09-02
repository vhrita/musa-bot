const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const winston = require('winston');

const app = express();
const port = process.env.PORT || 3001;

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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'youtube-resolver',
    timestamp: new Date().toISOString()
  });
});

// Search YouTube videos
app.post('/search', async (req, res) => {
  const { query, maxResults = 3 } = req.body;
  
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  logger.info('YouTube search request', { query, maxResults });

  try {
    const results = await searchYouTube(query, maxResults);
    logger.info('Search completed', { query, resultsCount: results.length });
    res.json({ results });
  } catch (error) {
    logger.error('Search failed', { query, error: error.message });
    res.status(500).json({ error: 'Search failed', message: error.message });
  }
});

// Get stream URL for a specific video
app.post('/stream', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  logger.info('Stream URL request', { url });

  try {
    const streamUrl = await getStreamUrl(url);
    if (streamUrl) {
      logger.info('Stream URL resolved', { originalUrl: url, resolved: true });
      res.json({ streamUrl });
    } else {
      logger.warn('Stream URL not found', { url });
      res.status(404).json({ error: 'Stream URL not found' });
    }
  } catch (error) {
    logger.error('Stream resolution failed', { url, error: error.message });
    res.status(500).json({ error: 'Stream resolution failed', message: error.message });
  }
});

// Search YouTube using yt-dlp with cookies-from-browser
function searchYouTube(query, maxResults) {
  return new Promise((resolve, reject) => {
    const searchQuery = `ytsearch${maxResults}:${query}`;
    
    const ytDlpArgs = [
      '--dump-json',
      '--no-warnings',
      '--skip-download',
      '--cookies-from-browser', 'chrome',  // Use Chrome cookies directly
      searchQuery
    ];

    logger.info('Executing yt-dlp search', { command: 'yt-dlp', args: ytDlpArgs });

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
          // Skip malformed JSON lines
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

// Get stream URL using yt-dlp with cookies-from-browser
function getStreamUrl(videoUrl) {
  return new Promise((resolve, reject) => {
    const ytDlpArgs = [
      '--get-url',
      '--format', 'bestaudio[ext=m4a]/bestaudio/best',
      '--no-playlist',
      '--cookies-from-browser', 'chrome',  // Use Chrome cookies directly
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
  logger.info('YouTube Resolver API started', { port });
  console.log(`🎵 YouTube Resolver API running on port ${port}`);
  console.log(`🔍 Search: POST http://localhost:${port}/search`);
  console.log(`🎬 Stream: POST http://localhost:${port}/stream`);
  console.log(`❤️ Health: GET http://localhost:${port}/health`);
});
