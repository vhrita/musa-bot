import fs from 'fs';
import { BaseMusicService } from './BaseMusicService';
import { MusicSource, ServiceType } from '../types/music';
import { logEvent, logError } from '../utils/logger';
import { spawn, ChildProcess } from 'child_process';
import { botConfig } from '../config';

export class YouTubeService extends BaseMusicService {
  // We no longer rely on the deprecated ytmusicsearch scheme.
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
        maxResults,
        prefer: 'music_first',
      });

      // First pass: prefer Music client via extractor-args; fallback: default clients
      const musicFirst = await this.searchWithYtDlp(query, maxResults, 'music');
      const results =
        musicFirst.length > 0 ? musicFirst : await this.searchWithYtDlp(query, maxResults, 'default');

      logEvent('youtube_search_completed', {
        query,
        resultsCount: results.length,
        used: musicFirst.length > 0 ? 'music_client' : 'default',
      });

      return results;
    } catch (error) {
      logError('YouTube search failed', error as Error, {
        query,
        maxResults,
      });
      return [];
    }
  }

  private async searchWithYtDlp(
    query: string,
    maxResults: number,
    engine: 'music' | 'default' = 'music',
  ): Promise<MusicSource[]> {
    return new Promise((resolve) => {
      const searchQuery = `ytsearch${maxResults}:${query}`;

      // Use yt-dlp to search for videos
      const ytDlpArgs = [
        '--dump-json',
        '--no-warnings',
        '--skip-download',
        '--user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
      ];

      // Add cookies if configured
      if (botConfig.ytdlpCookies) {
        const cookiePath = botConfig.ytdlpCookies;

        logEvent('youtube_cookies_check', {
          cookiePath,
          query,
        });

        try {
          if (fs.existsSync(cookiePath)) {
            const stats = fs.statSync(cookiePath);
            const cookieContent = fs.readFileSync(cookiePath, 'utf8');
            const cookieLines = cookieContent
              .split('\n')
              .filter((line: string) => line.trim() && !line.startsWith('#')).length;

            logEvent('youtube_cookies_loaded', {
              cookiePath,
              fileSize: stats.size,
              cookieLines,
              lastModified: stats.mtime,
              query,
            });

            // Create a temporary copy of cookies to avoid permission issues
            const tempCookiesPath = `/tmp/yt-dlp-cookies-${Date.now()}-${Math.random().toString(36).substring(2, 11)}.txt`;
            fs.writeFileSync(tempCookiesPath, cookieContent);

            logEvent('youtube_temp_cookies_created', {
              originalPath: cookiePath,
              tempPath: tempCookiesPath,
              query,
            });

            ytDlpArgs.push('--cookies', tempCookiesPath);
            // Better compatibility
            ytDlpArgs.push('--no-check-certificate');
          } else {
            logError('YouTube cookies file not found', new Error(`File not found: ${cookiePath}`), {
              cookiePath,
              query,
            });
          }
        } catch (error) {
          logError('Error reading YouTube cookies file', error as Error, {
            cookiePath,
            query,
          });
        }
      } else {
        logEvent('youtube_cookies_not_configured', {
          query,
          message: 'YTDLP_COOKIES environment variable not set',
        });
      }

      // Prefer Music client first; fallback uses default
      if (engine === 'music') {
        ytDlpArgs.push('--extractor-args', 'youtube:player_client=web_music,web');
      } else {
        ytDlpArgs.push('--extractor-args', 'youtube:player_client=default');
      }

      // Add the search query
      ytDlpArgs.push(searchQuery);

      logEvent('youtube_ytdlp_command', {
        command: 'yt-dlp',
        args: ytDlpArgs.join(' '),
        query,
        engine,
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
            exitCode: code,
          });
          return resolve([]);
        }

        try {
          const results: MusicSource[] = [];
          const lines = output
            .trim()
            .split('\n')
            .filter((line) => line.trim());

          // Helper: only accept direct YouTube video URLs (not channels/playlists)
          const isVideoUrl = (u: string): boolean => {
            try {
              const url = new URL(u);
              const host = url.hostname.toLowerCase();
              const isYt =
                host === 'youtu.be' ||
                host === 'www.youtube.com' ||
                host === 'youtube.com' ||
                host.endsWith('.youtube.com');
              if (!isYt) return false;
              if (host === 'youtu.be') {
                const id = url.pathname.replace(/^\//, '');
                return !!(id && id.length === 11);
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
            try {
              const video = JSON.parse(line);

              // Skip if this is not a video entry or missing required fields
              if (!video.id || !video.title) {
                continue;
              }
              const candidateUrl =
                (video.webpage_url as string) || `https://www.youtube.com/watch?v=${video.id}`;
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
                thumbnail: video.thumbnail || undefined,
              });
            } catch (parseError) {
              // Skip malformed JSON lines
              continue;
            }
          }

          logEvent('youtube_search_parsed', {
            query,
            foundVideos: results.length,
          });

          resolve(results);
        } catch (error) {
          logError('Failed to parse yt-dlp output', error as Error, {
            query,
            output: output.substring(0, 500),
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
        url: source.url,
      });

      return new Promise<string | null>((resolve) => {
        let output = '';
        let errorOutput = '';

        // Use yt-dlp to get the actual stream URL
        const ytDlpArgs = [
          '--get-url',
          '--format',
          'bestaudio[ext=m4a]/bestaudio/best',
          '--no-playlist',
          '--user-agent',
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
        ];

        // Add cookies if configured
        if (botConfig.ytdlpCookies) {
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
                url: source.url,
              });
            } else {
              logEvent('youtube_stream_cookies_missing', {
                cookiePath,
                title: source.title,
                url: source.url,
              });
            }
          } catch (error) {
            logError('Error checking cookies for stream URL', error as Error, {
              cookiePath,
              title: source.title,
              url: source.url,
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
              exitCode: code,
            });
            resolve(null);
            return;
          }

          const streamUrl = output.trim().split('\n')[0];
          if (streamUrl?.startsWith('http')) {
            logEvent('youtube_stream_url_extracted', {
              title: source.title,
              originalUrl: source.url,
              streamUrl: streamUrl.substring(0, 100) + '...', // Log only first 100 chars for security
            });
            resolve(streamUrl);
          } else {
            logError('Invalid YouTube stream URL', new Error('No valid URL found'), {
              title: source.title,
              url: source.url,
              output: output.substring(0, 200),
            });
            resolve(null);
          }
        });

        ytDlp.on('error', (error) => {
          logError('yt-dlp process error during stream URL extraction', error, {
            title: source.title,
            url: source.url,
          });
          resolve(null);
        });
      });
    } catch (error) {
      logError('Failed to get YouTube stream URL', error as Error, {
        title: source.title,
        url: source.url,
      });
      return null;
    }
  }

  validateUrl(url: string): boolean {
    // Basic YouTube URL validation
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
    return youtubeRegex.test(url);
  }

  // Fetch basic metadata (thumbnail/creator/duration) for a YouTube video URL
  async fetchMeta(videoUrl: string): Promise<{
    title?: string;
    thumbnail?: string;
    creator?: string;
    duration?: number;
  } | null> {
    return new Promise((resolve) => {
      let output = '';
      const args = [
        '--dump-json',
        '--no-warnings',
        '--skip-download',
        '--no-check-certificate',
        '--geo-bypass',
        '--socket-timeout',
        String(botConfig.ytdlpSocketTimeoutSeconds ?? 20),
        '--user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
        videoUrl,
      ];

      // Add cookies if configured and accessible (best-effort)
      if (botConfig.ytdlpCookies) {
        try {
          if (fs.existsSync(botConfig.ytdlpCookies)) {
            const cookieContent = fs.readFileSync(botConfig.ytdlpCookies, 'utf8');
            const tempCookiesPath = `/tmp/yt-dlp-meta-cookies-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.txt`;
            fs.writeFileSync(tempCookiesPath, cookieContent);
            args.splice(-1, 0, '--cookies', tempCookiesPath);
          }
        } catch {
          /* ignore cookie problems */
        }
      }

      // Optional proxy support if configured
      if (botConfig.ytdlpProxy) {
        // Insert before URL
        args.splice(-1, 0, '--proxy', botConfig.ytdlpProxy);
      }

      const p = spawn('yt-dlp', args);
      p.stdout.on('data', (d) => {
        output += d.toString();
      });
      p.on('close', () => {
        try {
          const line = output.trim().split('\n')[0] || '';
          const data = line ? JSON.parse(line) : {};
          if (!data) return resolve(null);
          const meta: any = {};
          if (typeof data.title === 'string') meta.title = data.title;
          if (typeof data.uploader === 'string') meta.creator = data.uploader;
          if (typeof data.duration === 'number') meta.duration = data.duration;
          if (typeof data.thumbnail === 'string') meta.thumbnail = data.thumbnail;
          return resolve(meta);
        } catch {
          return resolve(null);
        }
      });
      p.on('error', () => resolve(null));
    });
  }

  /**
   * Spawn a yt-dlp process that downloads the audio for `source` through the
   * configured proxy and pipes raw bytes to its stdout.
   *
   * The caller is responsible for consuming `proc.stdout` and killing `proc`
   * when playback stops, skips, or errors — see MusicManager.createYouTubePipeResource.
   *
   * Returns the spawned ChildProcess.  The process is NOT waited on here; the
   * caller drives the lifecycle.
   */
  spawnPipeStream(source: MusicSource): ChildProcess {
    logEvent('youtube_pipe_stream_spawn', {
      title: source.title,
      url: source.url,
    });

    // Best-audio formats, prefer webm (opus-native) then m4a, then anything
    const format = 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio';

    const ytDlpArgs: string[] = [
      '--no-playlist',
      '--format',
      format,
      '--output',
      '-', // write audio bytes to stdout
      '--quiet', // suppress progress bar (stderr still carries errors)
      '--no-warnings',
      '--socket-timeout',
      String(botConfig.ytdlpSocketTimeoutSeconds ?? 20),
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    ];

    // Proxy: if set, all network traffic goes through WARP — this is the whole point
    const proxy = botConfig.ytdlpProxy;
    if (proxy) {
      ytDlpArgs.push('--proxy', proxy);
    } else {
      logEvent('youtube_pipe_stream_no_proxy', {
        title: source.title,
        url: source.url,
        message: 'YTDLP_PROXY not set — downloading direct (degraded, may be bot-blocked)',
      });
    }

    // Cookies: best-effort, same pattern as getStreamUrl
    if (botConfig.ytdlpCookies) {
      const cookiePath = botConfig.ytdlpCookies;
      try {
        if (fs.existsSync(cookiePath)) {
          const cookieContent = fs.readFileSync(cookiePath, 'utf8');
          const tempCookiesPath = `/tmp/yt-dlp-pipe-cookies-${Date.now()}-${Math.random().toString(36).substring(2, 9)}.txt`;
          fs.writeFileSync(tempCookiesPath, cookieContent);
          ytDlpArgs.push('--cookies', tempCookiesPath);
        }
      } catch (err) {
        logError('youtube_pipe_stream: error setting up cookies (ignored)', err as Error, {
          cookiePath,
          title: source.title,
        });
      }
    }

    // The watch URL is always the canonical youtube.com/watch?v=... from the queue
    ytDlpArgs.push(source.url);

    logEvent('youtube_pipe_stream_command', {
      title: source.title,
      url: source.url,
      hasProxy: !!proxy,
      hasCookies: !!botConfig.ytdlpCookies,
      format,
    });

    const proc = spawn('yt-dlp', ytDlpArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Surface yt-dlp stderr to structured logs without blocking
    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    proc.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGKILL') {
        // Only log as error if not killed intentionally (SIGKILL = normal stop/skip)
        if (stderrBuf.trim()) {
          logError('youtube_pipe_stream_ytdlp_exit_nonzero', new Error(stderrBuf.trim()), {
            title: source.title,
            url: source.url,
            exitCode: code,
            signal,
          });
        } else {
          logEvent('youtube_pipe_stream_ytdlp_exit', {
            title: source.title,
            url: source.url,
            exitCode: code,
            signal,
          });
        }
      } else {
        logEvent('youtube_pipe_stream_ytdlp_done', {
          title: source.title,
          url: source.url,
          exitCode: code,
          signal,
        });
      }
    });

    proc.on('error', (err) => {
      logError('youtube_pipe_stream_ytdlp_error', err, {
        title: source.title,
        url: source.url,
      });
    });

    return proc;
  }
}
