import { BaseMusicService } from './BaseMusicService';
import { MusicSource, ServiceType } from '../types/music';
import { logEvent, logError } from '../utils/logger';
import axios from 'axios';
import { spawn } from 'child_process';

export class ResolverYouTubeService extends BaseMusicService {
  private readonly resolverUrl: string;

  constructor(priority: number = 1, enabled: boolean = true) {
    super('youtube', priority, enabled);
    this.resolverUrl = process.env.RESOLVER_URL || 'http://localhost:3001';
  }

  async search(query: string, maxResults: number): Promise<MusicSource[]> {
    if (!this.isEnabled()) {
      return [];
    }

    // First, try the resolver if available
    try {
      const isHealthy = await this.isResolverHealthy();
      if (isHealthy) {
        return await this.searchWithResolver(query, maxResults);
      } else {
        logEvent('resolver_unhealthy_fallback', {
          query,
          maxResults,
          resolverUrl: this.resolverUrl
        });
        return await this.searchWithDirectYtDlp(query, maxResults);
      }
    } catch (error) {
      logError('Resolver failed, using direct yt-dlp', error as Error, {
        query,
        maxResults,
        resolverUrl: this.resolverUrl
      });
      return await this.searchWithDirectYtDlp(query, maxResults);
    }
  }

  private async searchWithResolver(query: string, maxResults: number): Promise<MusicSource[]> {
    logEvent('resolver_youtube_search_started', {
      query,
      maxResults,
      resolverUrl: this.resolverUrl,
      method: 'resolver'
    });

    const response = await axios.post(`${this.resolverUrl}/search`, {
      query,
      maxResults
    }, {
      timeout: 60000 // Increased timeout for Raspberry Pi
    });

    const results = response.data.results || [];

    logEvent('resolver_youtube_search_completed', {
      query,
      resultsCount: results.length,
      method: 'resolver'
    });

    return results;
  }

  private async searchWithDirectYtDlp(query: string, maxResults: number): Promise<MusicSource[]> {
    return new Promise((resolve) => {
      const searchQuery = `ytsearch${maxResults}:${query}`;
      
      logEvent('resolver_youtube_search_started', {
        query,
        maxResults,
        method: 'direct_ytdlp'
      });
      
      // Use optimized yt-dlp flags as fallback (same as resolver)
      const ytDlpArgs = [
        '--dump-json',
        '--default-search', 'ytsearch',
        '--no-playlist',
        '--no-check-certificate', 
        '--geo-bypass',
        '--flat-playlist',
        '--skip-download',
        '--quiet',
        '--ignore-errors',
        '--socket-timeout', '15',
        '--max-downloads', maxResults.toString(),
        searchQuery
      ];

      // Only add cookies if file exists and is readable (avoid permission errors)
      const cookiePath = process.env.YTDLP_COOKIES;
      if (cookiePath) {
        const fs = require('fs');
        try {
          if (fs.existsSync(cookiePath)) {
            // Test if file is readable before adding to args
            fs.accessSync(cookiePath, fs.constants.R_OK);
            ytDlpArgs.splice(-1, 0, '--cookies', cookiePath);
            logEvent('resolver_ytdlp_cookies_added', { cookiePath, query });
          } else {
            logEvent('resolver_ytdlp_cookies_not_found', { cookiePath, query });
          }
        } catch (error) {
          logEvent('resolver_ytdlp_cookies_error', { 
            cookiePath, 
            query, 
            error: (error as Error).message 
          });
        }
      } else {
        logEvent('resolver_ytdlp_no_cookies', { query });
      }

      logEvent('resolver_youtube_ytdlp_command', {
        command: 'yt-dlp',
        args: ytDlpArgs.join(' '),
        query,
        method: 'direct_ytdlp'
      });
      
      const ytDlp = spawn('yt-dlp', ytDlpArgs);
      let output = '';
      let errorOutput = '';
      let isTimedOut = false;

      // Add timeout for direct yt-dlp as well
      const timeoutId = setTimeout(() => {
        isTimedOut = true;
        ytDlp.kill('SIGKILL');
        logEvent('resolver_ytdlp_timeout', { query, timeout: 30000 });
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
          logEvent('resolver_ytdlp_timed_out', { query });
          resolve([]);
          return;
        }

        if (code !== 0) {
          logError('Direct yt-dlp search failed', new Error(errorOutput), {
            query,
            exitCode: code,
            method: 'direct_ytdlp'
          });
          resolve([]);
          return;
        }

        const results: MusicSource[] = [];
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
                service: 'youtube' as ServiceType
              });
            }
          } catch (parseError) {
            // Skip malformed JSON lines - log error for debugging
            logError('Failed to parse yt-dlp JSON output line', parseError as Error, {
              line: line.substring(0, 100) + (line.length > 100 ? '...' : ''),
              method: 'direct_ytdlp'
            });
            continue;
          }
        }

        logEvent('resolver_youtube_search_completed', {
          query,
          resultsCount: results.length,
          method: 'direct_ytdlp'
        });

        resolve(results);
      });

      ytDlp.on('error', (error) => {
        logError('Direct yt-dlp process error', error, { 
          query,
          method: 'direct_ytdlp'
        });
        resolve([]);
      });
    });
  }

  async getStreamUrl(url: string): Promise<string | null> {
    if (!this.isEnabled()) {
      return null;
    }

    // First, try the resolver if available
    try {
      const isHealthy = await this.isResolverHealthy();
      if (isHealthy) {
        return await this.getStreamUrlWithResolver(url);
      } else {
        logEvent('resolver_unhealthy_fallback_stream', {
          url,
          resolverUrl: this.resolverUrl
        });
        return await this.getStreamUrlWithDirectYtDlp(url);
      }
    } catch (error) {
      logError('Resolver stream failed, using direct yt-dlp', error as Error, {
        url,
        resolverUrl: this.resolverUrl
      });
      return await this.getStreamUrlWithDirectYtDlp(url);
    }
  }

  private async getStreamUrlWithResolver(url: string): Promise<string | null> {
    logEvent('resolver_youtube_stream_started', {
      url,
      resolverUrl: this.resolverUrl,
      method: 'resolver'
    });

    const response = await axios.post(`${this.resolverUrl}/stream`, {
      url
    }, {
      timeout: 60000 // 60 seconds timeout
    });

    const streamUrl = response.data.streamUrl;

    logEvent('resolver_youtube_stream_completed', {
      url,
      hasStreamUrl: !!streamUrl,
      method: 'resolver'
    });

    return streamUrl || null;
  }

  private async getStreamUrlWithDirectYtDlp(url: string): Promise<string | null> {
    return new Promise((resolve) => {
      logEvent('resolver_youtube_stream_started', {
        url,
        method: 'direct_ytdlp'
      });

      // Use yt-dlp directly to get stream URL
      const ytDlpArgs = [
        '--get-url',
        '--no-warnings',
        '--format', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
        url
      ];

      // Add cookies if available
      const cookiePath = process.env.YTDLP_COOKIES;
      if (cookiePath) {
        const fs = require('fs');
        if (fs.existsSync(cookiePath)) {
          ytDlpArgs.splice(-1, 0, '--cookies', cookiePath);
        }
      }

      logEvent('resolver_youtube_ytdlp_stream_command', {
        command: 'yt-dlp',
        args: ytDlpArgs.join(' '),
        url,
        method: 'direct_ytdlp'
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
          logError('Direct yt-dlp stream failed', new Error(errorOutput), {
            url,
            exitCode: code,
            method: 'direct_ytdlp'
          });
          resolve(null);
          return;
        }

        const streamUrl = output.trim();
        
        logEvent('resolver_youtube_stream_completed', {
          url,
          hasStreamUrl: !!streamUrl,
          method: 'direct_ytdlp'
        });

        resolve(streamUrl || null);
      });

      ytDlp.on('error', (error) => {
        logError('Direct yt-dlp stream process error', error, { 
          url,
          method: 'direct_ytdlp'
        });
        resolve(null);
      });
    });
  }

  validateUrl(url: string): boolean {
    // Basic YouTube URL validation
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
    return youtubeRegex.test(url);
  }

  // Health check method
  async isResolverHealthy(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.resolverUrl}/health`, {
        timeout: 5000
      });
      
      const isHealthy = response.status === 200 && response.data.status === 'ok';
      
      logEvent('resolver_health_check', {
        resolverUrl: this.resolverUrl,
        healthy: isHealthy,
        status: response.data.status
      });

      return isHealthy;
    } catch (error) {
      logError('Raspberry resolver health check failed', error as Error, {
        resolverUrl: this.resolverUrl
      });
      return false;
    }
  }
}
