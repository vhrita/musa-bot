import { BaseMusicService } from './BaseMusicService';
import { MusicSource, ServiceType } from '../types/music';
import { logEvent, logError } from '../utils/logger';
import { spawn } from 'child_process';

export class YouTubeService extends BaseMusicService {
  constructor(priority: number, enabled: boolean) {
    super('youtube' as ServiceType, priority, enabled);
  }

  async search(query: string, maxResults: number): Promise<MusicSource[]> {
    if (!this.isEnabled()) {
      return [];
    }

    try {
      logEvent('youtube_search_started', {
        query,
        maxResults
      });

      const results = await this.searchWithYtDlp(query, maxResults);

      logEvent('youtube_search_completed', {
        query,
        resultsCount: results.length
      });

      return results;

    } catch (error) {
      logError('YouTube search failed', error as Error, {
        query,
        maxResults
      });
      return [];
    }
  }

  private async searchWithYtDlp(query: string, maxResults: number): Promise<MusicSource[]> {
    return new Promise((resolve) => {
      const searchQuery = `ytsearch${maxResults}:${query}`;
      
      // Build yt-dlp arguments
      const args = [
        '--dump-json',
        '--no-warnings',
        '--skip-download',
        '--no-write-cookies'  // Prevent yt-dlp from trying to save cookies
      ];

      // Add cookies if configured
      if (process.env.YTDLP_COOKIES) {
        const fs = require('fs');
        const cookiePath = process.env.YTDLP_COOKIES;
        
        logEvent('youtube_cookies_check', {
          cookiePath,
          query
        });

        try {
          if (fs.existsSync(cookiePath)) {
            const stats = fs.statSync(cookiePath);
            const cookieContent = fs.readFileSync(cookiePath, 'utf8');
            const cookieLines = cookieContent.split('\n').filter((line: string) => 
              line.trim() && !line.startsWith('#')
            ).length;

            logEvent('youtube_cookies_loaded', {
              cookiePath,
              fileSize: stats.size,
              cookieLines,
              lastModified: stats.mtime,
              query
            });

            args.push('--cookies', cookiePath);
          } else {
            logError('YouTube cookies file not found', new Error(`File not found: ${cookiePath}`), {
              cookiePath,
              query
            });
          }
        } catch (error) {
          logError('Error reading YouTube cookies file', error as Error, {
            cookiePath,
            query
          });
        }
      } else {
        logEvent('youtube_cookies_not_configured', {
          query,
          message: 'YTDLP_COOKIES environment variable not set'
        });
      }

      // Add the search query
      args.push(searchQuery);
      
      logEvent('youtube_ytdlp_command', {
        command: 'yt-dlp',
        args: args.join(' '),
        query
      });
      
      const ytDlp = spawn('yt-dlp', args);

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
          logError('yt-dlp search failed', new Error(errorOutput), {
            query,
            exitCode: code
          });
          resolve([]);
          return;
        }

        try {
          const results: MusicSource[] = [];
          const lines = output.trim().split('\n').filter(line => line.trim());

          for (const line of lines) {
            try {
              const video = JSON.parse(line);
              
              // Skip if this is not a video entry or missing required fields
              if (!video.id || !video.title) {
                continue;
              }
              
              results.push({
                title: video.title || 'Unknown Title',
                url: video.webpage_url || `https://www.youtube.com/watch?v=${video.id}`,
                duration: video.duration || undefined,
                creator: video.uploader || video.channel || undefined,
                service: 'youtube' as ServiceType,
                thumbnail: video.thumbnail || undefined
              });
            } catch (parseError) {
              // Skip malformed JSON lines
              continue;
            }
          }

          logEvent('youtube_search_parsed', {
            query,
            foundVideos: results.length
          });

          resolve(results);
        } catch (error) {
          logError('Failed to parse yt-dlp output', error as Error, {
            query,
            output: output.substring(0, 500)
          });
          resolve([]);
        }
      });

      ytDlp.on('error', (error) => {
        logError('yt-dlp process error', error, { query });
        resolve([]);
      });
    });
  }

  async getStreamUrl(source: MusicSource): Promise<string | null> {
    try {
      logEvent('youtube_stream_url_requested', {
        title: source.title,
        url: source.url
      });

      return new Promise<string | null>((resolve) => {
        let output = '';
        let errorOutput = '';

        // Use yt-dlp to get the actual stream URL
        const ytDlpArgs = [
          '--get-url',
          '--format', 'bestaudio[ext=m4a]/bestaudio/best',
          '--no-playlist',
          '--no-write-cookies'  // Prevent yt-dlp from trying to save cookies
        ];

        // Add cookies if configured
        if (process.env.YTDLP_COOKIES) {
          const fs = require('fs');
          const cookiePath = process.env.YTDLP_COOKIES;
          
          try {
            if (fs.existsSync(cookiePath)) {
              ytDlpArgs.push('--cookies', cookiePath);
              logEvent('youtube_stream_cookies_used', {
                cookiePath,
                title: source.title,
                url: source.url
              });
            } else {
              logEvent('youtube_stream_cookies_missing', {
                cookiePath,
                title: source.title,
                url: source.url
              });
            }
          } catch (error) {
            logError('Error checking cookies for stream URL', error as Error, {
              cookiePath,
              title: source.title,
              url: source.url
            });
          }
        }

        // Add proxy if configured
        const proxy = process.env.YTDLP_PROXY;
        if (proxy) {
          ytDlpArgs.push('--proxy', proxy);
        }

        // Add the URL
        ytDlpArgs.push(source.url);

        const ytDlp = spawn('yt-dlp', ytDlpArgs);

        ytDlp.stdout.on('data', (data) => {
          output += data.toString();
        });

        ytDlp.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        ytDlp.on('close', (code) => {
          if (code !== 0) {
            logError('Failed to get YouTube stream URL', new Error(errorOutput), {
              title: source.title,
              url: source.url,
              exitCode: code
            });
            resolve(null);
            return;
          }

          const streamUrl = output.trim().split('\n')[0];
          if (streamUrl?.startsWith('http')) {
            logEvent('youtube_stream_url_extracted', {
              title: source.title,
              originalUrl: source.url,
              streamUrl: streamUrl.substring(0, 100) + '...' // Log only first 100 chars for security
            });
            resolve(streamUrl);
          } else {
            logError('Invalid YouTube stream URL', new Error('No valid URL found'), {
              title: source.title,
              url: source.url,
              output: output.substring(0, 200)
            });
            resolve(null);
          }
        });

        ytDlp.on('error', (error) => {
          logError('yt-dlp process error during stream URL extraction', error, {
            title: source.title,
            url: source.url
          });
          resolve(null);
        });
      });

    } catch (error) {
      logError('Failed to get YouTube stream URL', error as Error, {
        title: source.title,
        url: source.url
      });
      return null;
    }
  }

  validateUrl(url: string): boolean {
    // Basic YouTube URL validation
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
    return youtubeRegex.test(url);
  }
}
