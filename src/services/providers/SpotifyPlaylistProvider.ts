import axios, { AxiosInstance } from 'axios';
import { PlaylistProvider, PlaylistMeta, PlaylistItemCandidate } from './types';
import { analyzeUrl } from '../../utils/providers';
import { botConfig } from '../../config';
import { logEvent, logWarning, logError } from '../../utils/logger';

interface SpotifyAuthToken {
  access_token: string;
  token_type: string; // 'Bearer'
  expires_in: number; // seconds
}

export class SpotifyPlaylistProvider implements PlaylistProvider {
  private token: { value: string; expiresAt: number } | null = null;
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: 'https://api.spotify.com/v1',
      timeout: botConfig.spotify?.timeoutMs ?? 12000,
    });
  }

  supports(url: string): boolean {
    const info = analyzeUrl(url);
    return info.provider === 'spotify' && !!info.spotifyPlaylistId; // treat playlist only here
  }

  async getMeta(url: string): Promise<PlaylistMeta | null> {
    const info = analyzeUrl(url);
    const id = info.spotifyPlaylistId;
    if (!id) return null;
    try {
      const token = await this.getAccessToken();
      const resp = await this.http.get(`/playlists/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { fields: 'name,owner(display_name),tracks(total)' }
      });
      const data = resp.data || {};
      const meta: PlaylistMeta = {
        id,
        title: data.name,
        owner: data.owner?.display_name,
        total: data.tracks?.total,
      };
      logEvent('spotify_playlist_meta', { id, title: meta.title, total: meta.total });
      return meta;
    } catch (error) {
      logError('spotify_get_meta_failed', error as Error, { id });
      return null;
    }
  }

  async *fetchItems(
    url: string,
    _opts?: { limit?: number; offset?: number; pageSize?: number }
  ): AsyncGenerator<PlaylistItemCandidate> {
    const info = analyzeUrl(url);
    const playlistId = info.spotifyPlaylistId;
    if (!playlistId) {
      logWarning('spotify_fetch_missing_id', { url });
      return;
    }

    const opts = _opts || {};
    const totalLimit = typeof opts.limit === 'number' && opts.limit >= 0 ? opts.limit : Infinity;
    const startOffset = Math.max(0, opts.offset || 0);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize || 100));

    let yielded = 0;
    let offset = startOffset;

    while (yielded < totalLimit) {
      const remaining = totalLimit === Infinity ? pageSize : Math.min(pageSize, totalLimit - yielded);
      const items = await this.fetchPage(playlistId, offset, remaining);
      if (!items || items.length === 0) break;

      for (const it of items) {
        if (yielded >= totalLimit) break;
        if (!it || !it.track || it.track.type !== 'track') continue; // skip episodes/local
        const t = it.track;
        const images = t.album?.images || [];
        const image = images[1]?.url || images[0]?.url || images[2]?.url;
        const candidate: PlaylistItemCandidate = {
          title: t.name,
          artists: (t.artists || []).map((a: any) => a?.name).filter(Boolean),
          durationMs: t.duration_ms,
          provider: 'spotify',
          providerUrl: t.external_urls?.spotify || url,
          thumbnailUrl: image,
        };
        yield candidate;
        yielded += 1;
      }

      if (items.length < remaining) break; // last page
      offset += items.length;
    }
  }

  // Fetch a single track metadata from a Spotify track URL or ID
  async getTrack(urlOrId: string): Promise<{
    title: string;
    artists: string[];
    durationMs?: number;
    thumbnailUrl?: string;
    providerUrl?: string;
  } | null> {
    const info = analyzeUrl(urlOrId);
    let trackId = info.trackId || (urlOrId && /^[a-zA-Z0-9]{22}$/.test(urlOrId) ? urlOrId : undefined);
    if (!trackId) {
      // Robust fallback: extract from URL path regardless of locale segment or query string
      try {
        const u = new URL(urlOrId);
        const m = /\/track\/([A-Za-z0-9]{22})(?:[/?#]|$)/.exec(u.pathname + (u.search || ''));
        if (m && m[1]) trackId = m[1];
      } catch {
        const m = /track\/?([A-Za-z0-9]{22})/.exec(String(urlOrId));
        if (m && m[1]) trackId = m[1];
      }
    }
    if (!trackId) return null;
    try {
      const token = await this.getAccessToken();
      const resp = await this.http.get(`/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { market: botConfig.spotify?.market || 'US' },
      });
      const t = resp.data;
      if (!t || t.type !== 'track') return null;
      const images = t.album?.images || [];
      const image = images[1]?.url || images[0]?.url || images[2]?.url;
      return {
        title: t.name,
        artists: (t.artists || []).map((a: any) => a?.name).filter(Boolean),
        durationMs: t.duration_ms,
        thumbnailUrl: image,
        providerUrl: t.external_urls?.spotify,
      };
    } catch (error) {
      logError('spotify_get_track_failed', error as Error, { urlOrId });
      return null;
    }
  }

  private async fetchPage(playlistId: string, offset: number, limit: number): Promise<any[]> {
    const maxAttempts = 3;
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const token = await this.getAccessToken();
        const resp = await this.http.get(`/playlists/${playlistId}/tracks`, {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            offset,
            limit: Math.min(100, Math.max(1, limit)),
            fields: 'items(track(name,duration_ms,external_urls,album(images),artists(name),type)),next'
          },
          validateStatus: () => true,
        });
        // Handle 429 with Retry-After
        if (resp.status === 429) {
          const retryAfter = Number(resp.headers['retry-after']) || 1;
          logWarning('spotify_rate_limited', { playlistId, offset, retryAfter });
          await new Promise(r => setTimeout(r, Math.min(5000, retryAfter * 1000)));
          continue;
        }
        if (resp.status >= 400) {
          throw new Error(`Spotify error ${resp.status}`);
        }
        const items = resp.data?.items || [];
        logEvent('spotify_playlist_page', { playlistId, offset, limit: items.length });
        return items;
      } catch (error) {
        if (attempt >= maxAttempts) {
          logError('spotify_fetch_page_failed', error as Error, { playlistId, offset, limit, attempt });
          break;
        }
        const backoff = 200 * attempt;
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    return [];
  }

  private async getAccessToken(): Promise<string> {
    if (!botConfig.spotify?.enabled) throw new Error('Spotify is disabled');
    const clientId = botConfig.spotify?.clientId || '';
    const clientSecret = botConfig.spotify?.clientSecret || '';
    if (!clientId || !clientSecret) throw new Error('Missing Spotify credentials');

    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 5000) {
      return this.token.value;
    }

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    try {
      const resp = await axios.post<SpotifyAuthToken>(
        'https://accounts.spotify.com/api/token',
        new URLSearchParams({ grant_type: 'client_credentials' }),
        {
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: botConfig.spotify?.timeoutMs ?? 12000,
        }
      );
      const data = resp.data;
      const expiresAt = Date.now() + (data.expires_in * 1000) - 10000; // 10s safety
      this.token = { value: data.access_token, expiresAt };
      logEvent('spotify_token_obtained', { expiresIn: data.expires_in });
      return this.token.value;
    } catch (error) {
      logError('spotify_token_failed', error as Error);
      throw error;
    }
  }
}

export default SpotifyPlaylistProvider;
