import { BaseMusicService } from './BaseMusicService';
import { MusicSource, ServiceType } from '../types/music';
import { logEvent, logError } from '../utils/logger';
import axios from 'axios';
import { botConfig } from '../config';
import { spawn } from 'child_process';
import { isYouTubeVideoUrl } from '../utils/providers';
import { buildYtDlpBaseArgs } from '../utils/ytdlp';

export class ResolverYouTubeService extends BaseMusicService {
  private readonly resolverUrl: string | null;
  private readonly resolverDisabled: boolean;

  constructor(priority: number = 1, enabled: boolean = true) {
    super('youtube', priority, enabled);
    if (botConfig.resolverUrl) {
      this.resolverUrl = botConfig.resolverUrl;
      this.resolverDisabled = false;
    } else {
      this.resolverUrl = null;
      this.resolverDisabled = true;
      // Log once at construction so operator can confirm the mode at startup
      logEvent('resolver_disabled_direct_mode', {
        reason: 'RESOLVER_URL not configured — skipping resolver, using yt-dlp directly',
      });
    }
  }

  async search(query: string, maxResults: number): Promise<MusicSource[]> {
    if (!this.isEnabled()) {
      return [];
    }

    // When resolver is disabled, skip health-check and go straight to yt-dlp
    if (this.resolverDisabled) {
      return await this.searchWithDirectYtDlp(query, maxResults);
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
          resolverUrl: this.resolverUrl,
        });
        return await this.searchWithDirectYtDlp(query, maxResults);
      }
    } catch (error) {
      logError('Resolver failed, using direct yt-dlp', error as Error, {
        query,
        maxResults,
        resolverUrl: this.resolverUrl,
      });
      return await this.searchWithDirectYtDlp(query, maxResults);
    }
  }

  private async searchWithResolver(query: string, maxResults: number): Promise<MusicSource[]> {
    logEvent('resolver_youtube_search_started', {
      query,
      maxResults,
      resolverUrl: this.resolverUrl,
      method: 'resolver',
    });

    const wantMetadata = maxResults > 1; // when only 1 result is needed, prefer minimal payload
    const response = await axios.post(
      `${this.resolverUrl!}/search`,
      {
        query,
        maxResults,
        metadata: wantMetadata,
      },
      {
        timeout: botConfig.resolver?.searchTimeoutMs || 120000,
      },
    );

    const raw = response.data.results || [];
    const results: MusicSource[] = (raw as any[])
      .map((r: any) => {
        if (!wantMetadata) {
          // Minimal mode: r likely { url, service }
          if (typeof r === 'string') {
            return { title: '', creator: '', duration: 0, url: r, service: 'youtube' as ServiceType };
          }
          if (r && typeof r.url === 'string') {
            return {
              title: '',
              creator: '',
              duration: 0,
              url: r.url,
              service: (r.service as ServiceType) || 'youtube',
            };
          }
          return null as any;
        }
        // Metadata mode: pass through
        if (r && typeof r.url === 'string') {
          return {
            title: typeof r.title === 'string' ? r.title : '',
            creator: typeof r.creator === 'string' ? r.creator : '',
            duration: typeof r.duration === 'number' ? r.duration : 0,
            url: r.url,
            thumbnail: typeof r.thumbnail === 'string' ? r.thumbnail : undefined,
            service: (r.service as ServiceType) || 'youtube',
          } as MusicSource;
        }
        return null as any;
      })
      .filter(Boolean) as MusicSource[];

    logEvent('resolver_youtube_search_completed', {
      query,
      resultsCount: results.length,
      method: 'resolver',
    });

    return results;
  }

  private async searchWithDirectYtDlp(query: string, maxResults: number): Promise<MusicSource[]> {
    return new Promise((resolve) => {
      // Single pass with web,tv client — avoids ios/mweb (GVS PoToken) and uses
      // the EJS n-sig solver (yt-dlp-ejs + --js-runtimes node from buildYtDlpBaseArgs).
      const trySearch = () =>
        new Promise<MusicSource[]>((res) => {
          const searchQuery = `ytsearch${maxResults}:${query}`;

          logEvent('resolver_youtube_search_started', {
            query,
            maxResults,
            method: 'direct_ytdlp',
            playerClient: 'web,tv',
          });

          // Optimized yt-dlp flags as fallback — UA + proxy + EJS from shared util
          const ytDlpArgs = [
            '--dump-json',
            '--default-search',
            'ytsearch',
            '--no-playlist',
            '--geo-bypass',
            '--skip-download',
            '--quiet',
            '--ignore-errors',
            '--max-downloads',
            maxResults.toString(),
            ...buildYtDlpBaseArgs({ includeSocketTimeout: true, includeProxy: true }),
            // player_client=web,tv: avoids ios/mweb (GVS PoToken required);
            // EJS n-sig solver handles signature resolution for web,tv.
            '--extractor-args',
            'youtube:player_client=web,tv',
          ];

          ytDlpArgs.push(searchQuery);

          logEvent('resolver_youtube_ytdlp_command', {
            command: 'yt-dlp',
            args: ytDlpArgs.join(' '),
            query,
            method: 'direct_ytdlp',
            playerClient: 'web,tv',
            hasProxy: !!botConfig.ytdlpProxy,
          });

          const ytDlp = spawn('yt-dlp', ytDlpArgs);
          let output = '';
          let errorOutput = '';
          let isTimedOut = false;

          // Add timeout for direct yt-dlp as well
          const timeoutId = setTimeout(() => {
            isTimedOut = true;
            ytDlp.kill('SIGKILL');
            logEvent('resolver_ytdlp_timeout', { query, timeout: 30000, playerClient: 'web,tv' });
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
              logEvent('resolver_ytdlp_timed_out', { query, playerClient: 'web,tv' });
              return res([]);
            }

            if (code !== 0) {
              logError('Direct yt-dlp search failed', new Error(errorOutput), {
                query,
                exitCode: code,
                method: 'direct_ytdlp',
                playerClient: 'web,tv',
              });
              return res([]);
            }

            const results: MusicSource[] = [];
            const lines = output.trim().split('\n');

            for (const line of lines) {
              if (!line.trim()) continue;

              try {
                const videoData = JSON.parse(line);

                if (videoData?.id && videoData?.title) {
                  const candidateUrl =
                    videoData.webpage_url || `https://www.youtube.com/watch?v=${videoData.id}`;
                  // Use canonical util — no inline duplicate
                  if (!isYouTubeVideoUrl(candidateUrl)) {
                    // Skip channels/playlists or non-video entries
                    continue;
                  }
                  results.push({
                    title: videoData.title,
                    creator: videoData.uploader || 'Unknown Artist',
                    duration: videoData.duration || 0,
                    url: candidateUrl,
                    thumbnail: videoData.thumbnail || '',
                    service: 'youtube' as ServiceType,
                  });
                }
              } catch (parseError) {
                // Skip malformed JSON lines - log error for debugging
                logError('Failed to parse yt-dlp JSON output line', parseError as Error, {
                  line: line.substring(0, 100) + (line.length > 100 ? '...' : ''),
                  method: 'direct_ytdlp',
                  playerClient: 'web,tv',
                });
                continue;
              }
            }

            logEvent('resolver_youtube_search_completed', {
              query,
              resultsCount: results.length,
              method: 'direct_ytdlp',
              playerClient: 'web,tv',
            });

            res(results);
          });

          ytDlp.on('error', (error) => {
            logError('Direct yt-dlp process error', error, {
              query,
              method: 'direct_ytdlp',
              playerClient: 'web,tv',
            });
            res([]);
          });
        });

      // Single pass — web,tv client handles n-sig via EJS solver
      trySearch().then(resolve);
    });
  }

  async getStreamUrl(source: MusicSource): Promise<string | null> {
    if (!this.isEnabled()) {
      return null;
    }

    const url = source.url; // Extract URL from MusicSource object

    // When resolver is disabled, skip health-check and go straight to yt-dlp
    if (this.resolverDisabled) {
      return await this.getStreamUrlWithDirectYtDlp(url);
    }

    // First, try the resolver if available
    try {
      const isHealthy = await this.isResolverHealthy();
      if (isHealthy) {
        return await this.getStreamUrlWithResolver(url);
      } else {
        logEvent('resolver_unhealthy_fallback_stream', {
          url,
          resolverUrl: this.resolverUrl,
        });
        return await this.getStreamUrlWithDirectYtDlp(url);
      }
    } catch (error) {
      logError('Resolver stream failed, using direct yt-dlp', error as Error, {
        url,
        resolverUrl: this.resolverUrl,
      });
      return await this.getStreamUrlWithDirectYtDlp(url);
    }
  }

  private async getStreamUrlWithResolver(url: string): Promise<string | null> {
    logEvent('resolver_youtube_stream_started', {
      url,
      resolverUrl: this.resolverUrl,
      method: 'resolver',
    });

    const response = await axios.post(
      `${this.resolverUrl!}/stream`,
      {
        url,
        proxy: true, // Enable proxy to avoid IP-based 403 errors
      },
      {
        timeout: botConfig.resolver?.streamTimeoutMs || 120000,
      },
    );

    const streamUrl = response.data.streamUrl;

    logEvent('resolver_youtube_stream_completed', {
      url,
      hasStreamUrl: !!streamUrl,
      method: 'resolver',
      usingProxy: true,
    });

    return streamUrl || null;
  }

  private async getStreamUrlWithDirectYtDlp(url: string): Promise<string | null> {
    return new Promise((resolve) => {
      logEvent('resolver_youtube_stream_started', {
        url,
        method: 'direct_ytdlp',
      });

      // Use yt-dlp directly to get stream URL — UA + proxy + EJS from shared util.
      // player_client=web,tv: avoids ios/mweb (GVS PoToken required); EJS n-sig
      // solver handles signature resolution for web,tv without bgutil.
      const ytDlpArgs = [
        '--get-url',
        '--no-warnings',
        '--format',
        'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
        ...buildYtDlpBaseArgs({ includeProxy: true }),
        '--extractor-args',
        'youtube:player_client=web,tv',
      ];

      ytDlpArgs.push(url);

      logEvent('resolver_youtube_ytdlp_stream_command', {
        command: 'yt-dlp',
        args: ytDlpArgs.join(' '),
        url,
        method: 'direct_ytdlp',
        playerClient: 'web,tv',
        hasProxy: !!botConfig.ytdlpProxy,
      });

      const ytDlp = spawn('yt-dlp', ytDlpArgs);
      let output = '';
      let errorOutput = '';
      let isTimedOut = false;

      // Add timeout for direct yt-dlp stream as well
      const timeoutId = setTimeout(() => {
        isTimedOut = true;
        ytDlp.kill('SIGKILL');
        logEvent('resolver_ytdlp_stream_timeout', { url, timeout: 90000 });
      }, 90000);

      ytDlp.stdout.on('data', (data) => {
        output += data.toString();
      });

      ytDlp.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      ytDlp.on('close', (code) => {
        clearTimeout(timeoutId);

        if (isTimedOut) {
          logEvent('resolver_ytdlp_stream_timed_out', { url });
          resolve(null);
          return;
        }

        if (code !== 0) {
          logError('Direct yt-dlp stream failed', new Error(errorOutput), {
            url,
            exitCode: code,
            method: 'direct_ytdlp',
          });
          resolve(null);
          return;
        }

        const streamUrl = output.trim();

        logEvent('resolver_youtube_stream_completed', {
          url,
          hasStreamUrl: !!streamUrl,
          method: 'direct_ytdlp',
        });

        resolve(streamUrl || null);
      });

      ytDlp.on('error', (error) => {
        logError('Direct yt-dlp stream process error', error, {
          url,
          method: 'direct_ytdlp',
        });
        resolve(null);
      });
    });
  }

  // Health check method
  async isResolverHealthy(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.resolverUrl!}/health`, {
        timeout: botConfig.resolver?.healthTimeoutMs || 5000,
      });

      const isHealthy = response.status === 200 && response.data.status === 'ok';

      logEvent('resolver_health_check', {
        resolverUrl: this.resolverUrl,
        healthy: isHealthy,
        status: response.data.status,
      });

      return isHealthy;
    } catch (error) {
      logError('Raspberry resolver health check failed', error as Error, {
        resolverUrl: this.resolverUrl,
      });
      return false;
    }
  }
}
