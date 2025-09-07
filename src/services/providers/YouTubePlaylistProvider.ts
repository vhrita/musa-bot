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
        '--ignore-errors',
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
          const id: string | undefined = row.id || row.url;
          const title: string = normalizeTitle(row.title || 'Unknown Title');
          if (!id) continue;
          const watchUrl = `https://www.youtube.com/watch?v=${id}`;
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
          if (row.thumbnail) candidate.thumbnailUrl = row.thumbnail;
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
