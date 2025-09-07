export type Provider = 'youtube' | 'ytm' | 'spotify' | 'unknown';
export type ContentKind = 'track' | 'playlist' | 'unknown';

export interface DetectedUrlInfo {
  provider: Provider;
  kind: ContentKind;
  // Normalized identifiers when detectable
  videoId?: string;       // YouTube/YouTube Music video id
  playlistId?: string;    // YouTube/YouTube Music playlist id (same as listId)
  listId?: string;        // alias for playlistId
  trackId?: string;       // Spotify track id
  albumId?: string;       // Spotify album id (not used yet)
  spotifyPlaylistId?: string; // Spotify playlist id
}

const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
]);

const YTM_HOSTS = new Set([
  'music.youtube.com',
  'www.music.youtube.com',
]);

const SPOTIFY_HOSTS = new Set([
  'open.spotify.com',
]);

function safeParseUrl(input: string): URL | null {
  try {
    // If input is missing protocol, try to prepend https://
    if (!/^https?:\/\//i.test(input)) {
      return new URL(`https://${input}`);
    }
    return new URL(input);
  } catch {
    return null;
  }
}

function getHost(url: URL): string {
  return url.hostname.toLowerCase();
}

// Public helpers (useful across commands/services)
export function isYouTubeUrl(input: string): boolean {
  const u = safeParseUrl(input);
  if (!u) return false;
  const h = getHost(u);
  return YT_HOSTS.has(h);
}

export function isYouTubeMusicUrl(input: string): boolean {
  const u = safeParseUrl(input);
  if (!u) return false;
  const h = getHost(u);
  return YTM_HOSTS.has(h);
}

export function isSpotifyUrl(input: string): boolean {
  const u = safeParseUrl(input);
  if (!u) return false;
  const h = getHost(u);
  return SPOTIFY_HOSTS.has(h);
}

export function isYouTubeVideoUrl(input: string): boolean {
  const u = safeParseUrl(input);
  if (!u) return false;
  const h = getHost(u);
  if (!YT_HOSTS.has(h)) return false;

  if (h === 'youtu.be') {
    const id = u.pathname.replace(/^\//, '');
    return !!(id && id.length === 11);
  }
  if (u.pathname === '/watch') {
    const v = u.searchParams.get('v');
    return !!(v && v.length === 11);
  }
  if (u.pathname.startsWith('/shorts/')) {
    const id = u.pathname.split('/')[2] || '';
    return id.length === 11;
  }
  return false;
}

export function isYouTubePlaylistUrl(input: string): boolean {
  const u = safeParseUrl(input);
  if (!u) return false;
  const h = getHost(u);
  if (!YT_HOSTS.has(h)) return false;
  const list = u.searchParams.get('list');
  return (u.pathname === '/playlist' && !!list) || (!!list && u.pathname === '/watch');
}

export function isYouTubeMusicTrackUrl(input: string): boolean {
  const u = safeParseUrl(input);
  if (!u) return false;
  const h = getHost(u);
  if (!YTM_HOSTS.has(h)) return false;
  if (u.pathname === '/watch') {
    const v = u.searchParams.get('v');
    return !!(v && v.length === 11);
  }
  return false;
}

export function isYouTubeMusicPlaylistUrl(input: string): boolean {
  const u = safeParseUrl(input);
  if (!u) return false;
  const h = getHost(u);
  if (!YTM_HOSTS.has(h)) return false;
  const list = u.searchParams.get('list');
  return (u.pathname === '/playlist' && !!list) || (!!list && u.pathname === '/watch');
}

function spotifyPathParts(u: URL): string[] {
  let parts = u.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return parts;
  // Spotify uses locale segment like "/intl-pt" before the resource type
  // e.g., /intl-pt/track/<id>
  const first = (parts[0] || '').toLowerCase();
  if (first === 'intl' || first.startsWith('intl-')) {
    parts = parts.slice(1);
  }
  return parts;
}

export function isSpotifyPlaylistUrl(input: string): boolean {
  const u = safeParseUrl(input);
  if (!u) return false;
  const h = getHost(u);
  if (!SPOTIFY_HOSTS.has(h)) return false;
  const parts = spotifyPathParts(u);
  return parts[0] === 'playlist' && !!parts[1];
}

export function isSpotifyTrackUrl(input: string): boolean {
  const u = safeParseUrl(input);
  if (!u) return false;
  const h = getHost(u);
  if (!SPOTIFY_HOSTS.has(h)) return false;
  const parts = spotifyPathParts(u);
  return parts[0] === 'track' && !!parts[1];
}

export function detectProvider(input: string): Provider {
  const u = safeParseUrl(input);
  if (!u) return 'unknown';
  const h = getHost(u);
  if (YTM_HOSTS.has(h)) return 'ytm';
  if (YT_HOSTS.has(h)) return 'youtube';
  if (SPOTIFY_HOSTS.has(h)) return 'spotify';
  return 'unknown';
}

export function detectContentKind(input: string): ContentKind {
  const u = safeParseUrl(input);
  if (!u) return 'unknown';
  const h = getHost(u);
  if (YTM_HOSTS.has(h)) {
    const list = u.searchParams.get('list');
    if ((u.pathname === '/playlist' && !!list) || (!!list && u.pathname === '/watch')) return 'playlist';
    if (u.pathname === '/watch' && u.searchParams.get('v')) return 'track';
  }
  if (YT_HOSTS.has(h)) {
    const list = u.searchParams.get('list');
    if ((u.pathname === '/playlist' && !!list) || (!!list && u.pathname === '/watch')) return 'playlist';
    if (u.pathname === '/watch' || u.hostname === 'youtu.be' || u.pathname.startsWith('/shorts/')) return 'track';
  }
  if (SPOTIFY_HOSTS.has(h)) {
    const parts = spotifyPathParts(u);
    if (parts[0] === 'playlist') return 'playlist';
    if (parts[0] === 'track') return 'track';
    if (parts[0] === 'album') return 'playlist'; // treat album as playlist-like
  }
  return 'unknown';
}

export function analyzeUrl(input: string): DetectedUrlInfo {
  const u = safeParseUrl(input);
  if (!u) return { provider: 'unknown', kind: 'unknown' };
  const provider = detectProvider(input);
  const kind = detectContentKind(input);

  const info: DetectedUrlInfo = { provider, kind };
  if (provider === 'youtube') {
    const v = u.searchParams.get('v');
    const list = u.searchParams.get('list');
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '');
      if (id) info.videoId = id;
    } else if (u.pathname === '/watch') {
      if (v) info.videoId = v;
      if (list) info.playlistId = info.listId = list;
    } else if (u.pathname === '/playlist' && list) {
      info.playlistId = info.listId = list;
    } else if (u.pathname.startsWith('/shorts/')) {
      const id = u.pathname.split('/')[2] || '';
      if (id) info.videoId = id;
    }
  } else if (provider === 'ytm') {
    const v = u.searchParams.get('v');
    const list = u.searchParams.get('list');
    if (u.pathname === '/watch' && v) info.videoId = v;
    if (list) info.playlistId = info.listId = list;
  } else if (provider === 'spotify') {
    const parts = spotifyPathParts(u);
    const type = parts[0];
    const id = parts[1];
    if (type === 'playlist' && id) info.spotifyPlaylistId = id;
    if (type === 'track' && id) info.trackId = id;
    if (type === 'album' && id) info.albumId = id; // treat as playlist-like
  }

  return info;
}
