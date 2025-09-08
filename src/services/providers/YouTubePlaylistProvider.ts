import { PlaylistMeta, PlaylistProvider, PlaylistItemCandidate } from './types';
import { analyzeUrl } from '../../utils/providers';
import { logEvent, logWarning, logError } from '../../utils/logger';
import { spawn } from 'child_process';
import { botConfig } from '../../config';
import fs from 'fs';
import { normalizeTitle } from '../../utils/text';

export class YouTubePlaylistProvider implements PlaylistProvider {
  supports(url: string): boolean {
    const info = analyzeUrl(url);
    const isYt = info.provider === 'youtube' || info.provider === 'ytm';
    // Consider playlist when explicit playlist URL or a video URL with listId present
    const isPlaylist = info.kind === 'playlist' || (!!info.listId);
    return isYt && isPlaylist;
  }

  async getMeta(url: string): Promise<PlaylistMeta | null> {
    const info = analyzeUrl(url);
    const listId = info.listId || info.playlistId;
    if (!listId) {
      logWarning('yt_playlist_get_meta_missing_list', { url });
      return null;
    }
    // Best-effort: return minimal meta (id). Title/total serão inferidos durante a listagem
    logEvent('yt_playlist_get_meta_started', { listId });
    return { id: listId };
  }

  async *fetchItems(
    url: string,
    _opts?: { limit?: number; offset?: number; pageSize?: number }
  ): AsyncGenerator<PlaylistItemCandidate> {
    const opts = _opts || {};
    const limit = typeof opts.limit === 'number' && opts.limit >= 0 ? opts.limit : Infinity;
    const offset = Math.max(0, opts?.offset || 0);
    const pageSize = Math.min(100, Math.max(1, opts?.pageSize || 100));

    let yielded = 0;
    let start = offset + 1; // yt-dlp is 1-based for playlist indexes

    // Loop in pages until we reach limit or no more results
    while (yielded < limit) {
      const remaining = limit === Infinity ? pageSize : Math.min(pageSize, limit - yielded);
      const end = start + remaining - 1;
      const args: string[] = [
        '--dump-json',
        '--flat-playlist',
        '--skip-download',
        '--no-check-certificate',
        '--geo-bypass',
        '--ignore-errors',
        '--socket-timeout', String(botConfig.ytdlpSocketTimeoutSeconds ?? 20),
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
        '--playlist-start', String(start),
        '--playlist-end', String(end),
        url,
      ];

      // Add cookies if configured and readable (avoid permission errors)
      const cookiePath = botConfig.ytdlpCookies;
      if (cookiePath) {
        try {
          fs.accessSync(cookiePath, fs.constants.R_OK);
          args.splice(-1, 0, '--cookies', cookiePath);
          logEvent('yt_playlist_cookies_added', { cookiePath });
        } catch (e) {
          logWarning('yt_playlist_cookies_unreadable', { cookiePath, error: (e as Error).message });
        }
      }

      // Optional proxy support (if configured)
      const proxy = botConfig.ytdlpProxy;
      if (proxy) {
        // Insert before URL
        args.splice(-1, 0, '--proxy', proxy);
      }

      logEvent('yt_playlist_ytdlp_command', {
        command: 'yt-dlp',
        args: args.join(' '),
        pageStart: start,
        pageEnd: end,
      });

      const output = await this.runYtDlp(args);
      if (output.code !== 0) {
        logError('yt-dlp playlist page failed', new Error(output.stderr || `exit ${output.code}`), {
          start, end
        });
        break;
      }

      const lines = output.stdout.trim().split('\n').filter((l) => l.trim());
      if (lines.length === 0) {
        // No more entries
        break;
      }

      for (const line of lines) {
        if (yielded >= limit) break;
        try {
          const row = JSON.parse(line);
          // Flat playlist entries often provide id/title/uploader; construct watch URL
          const rawId: string | undefined = (typeof row.id === 'string' ? row.id : undefined) || (typeof row.url === 'string' ? row.url : undefined);
          const title: string = normalizeTitle(row.title || 'Unknown Title');
          if (!rawId) continue;

          // Derive videoId and canonical watch URL
          const getVideoId = (val: string): string | null => {
            if (/^[0-9A-Za-z_-]{11}$/.test(val)) return val;
            try {
              const u = new URL(val);
              if (u.hostname === 'youtu.be') {
                const id = u.pathname.replace(/^\//, '');
                return /^[0-9A-Za-z_-]{11}$/.test(id) ? id : null;
              }
              if (u.hostname.endsWith('youtube.com')) {
                if (u.pathname.startsWith('/shorts/')) {
                  const id = (u.pathname.split('/')[2] || '');
                  return /^[0-9A-Za-z_-]{11}$/.test(id) ? id : null;
                }
                const v = u.searchParams.get('v') || '';
                return /^[0-9A-Za-z_-]{11}$/.test(v) ? v : null;
              }
              return null;
            } catch {
              return null;
            }
          };

          const videoId = getVideoId(rawId);
          if (!videoId) continue;
          const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
          const creator: string | undefined = row.uploader || row.channel || row.artist || undefined;
          const durationSec: number | undefined = typeof row.duration === 'number' ? row.duration : undefined;

          const candidate: PlaylistItemCandidate = {
            title,
            provider: 'youtube',
            providerUrl: url,
            youtubeVideoUrl: watchUrl,
          };
          if (creator) candidate.creator = creator;
          if (durationSec) candidate.durationMs = durationSec * 1000;
          if (typeof row.thumbnail === 'string' && row.thumbnail) {
            candidate.thumbnailUrl = row.thumbnail;
          } else {
            // Fallback to static thumbnail (no extra YouTube requests, avoids bot checks)
            candidate.thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
          }
          yield candidate;
          yielded += 1;
        } catch (e) {
          // Skip malformed lines
          logWarning('yt_playlist_parse_line_failed', { error: (e as Error).message });
          continue;
        }
      }

      // Advance to next page
      start = end + 1;
    }
  }

  private runYtDlp(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      const yt = spawn('yt-dlp', args);
      let stdout = '';
      let stderr = '';
      yt.stdout.on('data', (d) => { stdout += d.toString(); });
      yt.stderr.on('data', (d) => { stderr += d.toString(); });
      yt.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
      yt.on('error', (err) => resolve({ stdout: '', stderr: (err as Error).message, code: -1 }));
    });
  }
}

export default YouTubePlaylistProvider;
