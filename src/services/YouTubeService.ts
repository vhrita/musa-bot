import { BaseMusicService } from './BaseMusicService';
import { MusicSource, ServiceType } from '../types/music';
import { logEvent, logError } from '../utils/logger';
import { spawn, ChildProcess } from 'child_process';
import { botConfig } from '../config';
import { isYouTubeVideoUrl } from '../utils/providers';
import { buildYtDlpBaseArgs } from '../utils/ytdlp';

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

      // Use yt-dlp to search for videos — UA + proxy from shared util
      const ytDlpArgs = [
        '--dump-json',
        '--no-warnings',
        '--skip-download',
        ...buildYtDlpBaseArgs({ includeProxy: true }),
      ];

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
        hasProxy: !!botConfig.ytdlpProxy,
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

          for (const line of lines) {
            try {
              const video = JSON.parse(line);

              // Skip if this is not a video entry or missing required fields
              if (!video.id || !video.title) {
                continue;
              }
              const candidateUrl =
                (video.webpage_url as string) || `https://www.youtube.com/watch?v=${video.id}`;
              // Filter out channels/playlists — use canonical util from providers
              if (!isYouTubeVideoUrl(candidateUrl)) {
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

        // Use yt-dlp to get the actual stream URL — UA + proxy from shared util
        const ytDlpArgs = [
          '--get-url',
          '--format',
          'bestaudio[ext=m4a]/bestaudio/best',
          '--no-playlist',
          ...buildYtDlpBaseArgs({ includeProxy: true }),
          source.url,
        ];

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

  // Fetch basic metadata (thumbnail/creator/duration) for a YouTube video URL
  async fetchMeta(videoUrl: string): Promise<{
    title?: string;
    thumbnail?: string;
    creator?: string;
    duration?: number;
  } | null> {
    return new Promise((resolve) => {
      let output = '';
      // UA + proxy + socket-timeout from shared util; URL appended last
      const args = [
        '--dump-json',
        '--no-warnings',
        '--skip-download',
        '--geo-bypass',
        ...buildYtDlpBaseArgs({ includeSocketTimeout: true, includeProxy: true }),
        videoUrl,
      ];

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

    // UA + socket-timeout + proxy (WARP) from shared util
    const ytDlpArgs: string[] = [
      '--no-playlist',
      '--format',
      format,
      '--output',
      '-', // write audio bytes to stdout
      '--quiet', // suppress progress bar (stderr still carries errors)
      '--no-warnings',
      '--retries',
      '10', // retry on transient network errors (e.g. WARP hiccups)
      '--fragment-retries',
      '10', // retry individual fragments before giving up the track
      ...buildYtDlpBaseArgs({ includeSocketTimeout: true, includeProxy: true }),
    ];

    if (!botConfig.ytdlpProxy) {
      logEvent('youtube_pipe_stream_no_proxy', {
        title: source.title,
        url: source.url,
        message: 'YTDLP_PROXY not set — downloading direct (degraded, may be bot-blocked)',
      });
    }

    // The watch URL is always the canonical youtube.com/watch?v=... from the queue
    ytDlpArgs.push(source.url);

    logEvent('youtube_pipe_stream_command', {
      title: source.title,
      url: source.url,
      hasProxy: !!botConfig.ytdlpProxy,
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
        // Any non-zero exit that wasn't an intentional SIGKILL is an error —
        // always log at error level so it appears in error.log even when stderr
        // is empty (silent failures are the hardest to debug).
        logError(
          'youtube_pipe_stream_ytdlp_exit_nonzero',
          new Error(stderrBuf.trim() || `yt-dlp exited with code ${code}`),
          {
            title: source.title,
            url: source.url,
            exitCode: code,
            signal,
            hasStderr: stderrBuf.trim().length > 0,
          },
        );
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
