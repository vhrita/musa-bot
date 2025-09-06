import { BaseMusicService } from './BaseMusicService';
import { MusicSource, ServiceType } from '../types/music';
import { logEvent, logError } from '../utils/logger';
import { spawn } from 'child_process';
import { botConfig } from '../config';

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
      
              // Use yt-dlp to search for videos
        const ytDlpArgs = [
          '--dump-json',
          '--no-warnings',
          '--skip-download',
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
        ];

      // Add cookies if configured
      if (botConfig.ytdlpCookies) {
        const fs = require('fs');
        const cookiePath = botConfig.ytdlpCookies;
        
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

            // Create a temporary copy of cookies to avoid permission issues
            const tempCookiesPath = `/tmp/yt-dlp-cookies-${Date.now()}-${Math.random().toString(36).substring(2, 11)}.txt`;
            fs.writeFileSync(tempCookiesPath, cookieContent);
            
            logEvent('youtube_temp_cookies_created', {
              originalPath: cookiePath,
              tempPath: tempCookiesPath,
              query
            });

            ytDlpArgs.push('--cookies', tempCookiesPath);
            
            // Add additional flags for better YouTube compatibility
            ytDlpArgs.push('--extractor-args', 'youtube:player_client=android,web');
            ytDlpArgs.push('--no-check-certificate');
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
      ytDlpArgs.push(searchQuery);
      
      logEvent('youtube_ytdlp_command', {
        command: 'yt-dlp',
        args: ytDlpArgs.join(' '),
        query
      });
      
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

          // Helper: only accept direct YouTube video URLs (not channels/playlists)
          const isVideoUrl = (u: string): boolean => {
            try {
              const url = new URL(u);
              const host = url.hostname.toLowerCase();
              const isYt = host === 'youtu.be' || host === 'www.youtube.com' || host === 'youtube.com' || host.endsWith('.youtube.com');
              if (!isYt) return false;
              if (host === 'youtu.be') {
                const id = url.pathname.replace(/^\//, '');
                return !!(id && id.length === 11);
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
            try {
              const video = JSON.parse(line);
              
              // Skip if this is not a video entry or missing required fields
              if (!video.id || !video.title) {
                continue;
              }
              const candidateUrl = (video.webpage_url as string) || `https://www.youtube.com/watch?v=${video.id}`;
              // Filter out channels/playlists by URL pattern and video id length
              if (!isVideoUrl(candidateUrl)) {
                continue;
              }

              results.push({
                title: video.title || 'Unknown Title',
                url: candidateUrl,
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
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
        ];

        // Add cookies if configured
        if (botConfig.ytdlpCookies) {
          const fs = require('fs');
          const cookiePath = botConfig.ytdlpCookies;
          
          try {
            if (fs.existsSync(cookiePath)) {
              // Create a temporary copy of cookies to avoid permission issues
              const cookieContent = fs.readFileSync(cookiePath, 'utf8');
              const tempCookiesPath = `/tmp/yt-dlp-stream-cookies-${Date.now()}-${Math.random().toString(36).substring(2, 11)}.txt`;
              fs.writeFileSync(tempCookiesPath, cookieContent);
              
              ytDlpArgs.push('--cookies', tempCookiesPath);
              
              // Add additional flags for better YouTube compatibility
              ytDlpArgs.push('--extractor-args', 'youtube:player_client=android,web');
              ytDlpArgs.push('--no-check-certificate');
              
              logEvent('youtube_stream_cookies_used', {
                originalPath: cookiePath,
                tempPath: tempCookiesPath,
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
        const proxy = botConfig.ytdlpProxy;
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
