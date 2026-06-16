import { BaseMusicService } from './BaseMusicService';
import { MusicSource } from '../types/music';
import { logEvent, logError } from '../utils/logger';
import { spawn } from 'child_process';

/**
 * SoundCloudService — searches and streams via yt-dlp's scsearch extractor.
 *
 * Key differences from YouTubeService:
 *  - No proxy (SoundCloud rate-limits per client_id, not by IP — works from datacenter)
 *  - No --extractor-args player_client (YouTube-only flag)
 *  - No cookie handling (not needed for public tracks)
 *  - scsearch${N}:${query} instead of ytsearch${N}:${query}
 *
 * Playback: SoundCloud URLs go through the same yt-dlp pipe-stream path as YouTube
 * (createYouTubeStreamResource in MusicManager). They contain soundcloud.com in the
 * hostname, which is how MusicManager will route them.
 */
export class SoundCloudService extends BaseMusicService {
  constructor(priority: number, enabled: boolean) {
    super('soundcloud', priority, enabled);
  }

  async search(query: string, maxResults = 3): Promise<MusicSource[]> {
    if (!this.isEnabled()) {
      return [];
    }

    try {
      logEvent('soundcloud_search_started', { query, maxResults });
      const results = await this.searchWithYtDlp(query, maxResults);
      logEvent('soundcloud_search_completed', { query, resultsCount: results.length });
      return results;
    } catch (error) {
      logError('SoundCloud search failed', error as Error, { query, maxResults });
      return [];
    }
  }

  private searchWithYtDlp(query: string, maxResults: number): Promise<MusicSource[]> {
    return new Promise((resolve) => {
      const searchQuery = `scsearch${maxResults}:${query}`;

      // Minimal args: no proxy, no cookies, no player_client — SoundCloud doesn't need them.
      const ytDlpArgs = [
        '--dump-json',
        '--no-warnings',
        '--skip-download',
        '--flat-playlist',
        '--user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
        searchQuery,
      ];

      logEvent('soundcloud_ytdlp_command', {
        command: 'yt-dlp',
        args: ytDlpArgs.join(' '),
        query,
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
          logError('yt-dlp SoundCloud search failed', new Error(errorOutput), {
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
              const track = JSON.parse(line);

              if (!track.id || !track.title) continue;

              // Accept soundcloud.com URLs; fall back to webpage_url if available
              const url: string | undefined =
                (track.webpage_url as string | undefined) || (track.url as string | undefined);

              if (!url || !this.isSoundCloudUrl(url)) continue;

              const creator: string | undefined =
                (track.uploader as string | undefined) || (track.artist as string | undefined) || undefined;
              const thumbnail: string | undefined =
                (track.thumbnail as string | undefined) ||
                (track.thumbnails?.[0]?.url as string | undefined) ||
                undefined;

              results.push(
                this.createMusicSource({
                  title: this.cleanTitle(track.title as string),
                  url,
                  ...(typeof track.duration === 'number' ? { duration: track.duration } : {}),
                  ...(creator !== undefined ? { creator } : {}),
                  ...(thumbnail !== undefined ? { thumbnail } : {}),
                  isLiveStream: false,
                }),
              );
            } catch {
              // skip malformed JSON lines
            }
          }

          logEvent('soundcloud_search_parsed', { query, foundTracks: results.length });
          resolve(results);
        } catch (error) {
          logError('Failed to parse yt-dlp SoundCloud output', error as Error, {
            query,
            output: output.substring(0, 500),
          });
          resolve([]);
        }
      });

      ytDlp.on('error', (error) => {
        logError('yt-dlp SoundCloud process error', error, { query });
        resolve([]);
      });
    });
  }

  /**
   * Validates that a URL belongs to SoundCloud (soundcloud.com).
   * Overrides BaseMusicService.validateUrl for SoundCloud-specific check.
   */
  validateUrl(url: string): boolean {
    return this.isSoundCloudUrl(url);
  }

  private isSoundCloudUrl(url: string): boolean {
    try {
      const { hostname } = new URL(url);
      return hostname === 'soundcloud.com' || hostname.endsWith('.soundcloud.com');
    } catch {
      return false;
    }
  }
}
