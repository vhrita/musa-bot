import { MultiSourceManager } from './MultiSourceManager';
import { MusicSource } from '../types/music';
import { logEvent, logWarning } from '../utils/logger';
import { normalizeTitle } from '../utils/text';

export interface TrackResolverResult {
  url: string; // YouTube video URL
  confidence: number; // 0..1
  title: string;
  creator?: string;
  duration?: number; // seconds
}

type CacheEntry = TrackResolverResult & { ts: number };

function toSeconds(ms?: number): number | undefined {
  if (typeof ms !== 'number') return undefined;
  return Math.round(ms / 1000);
}

function norm(s: string): string {
  return normalizeTitle(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

const STYLE_TERMS = [
  'live',
  'cover',
  'sped up',
  'nightcore',
  '8d',
  'remix',
  'extended',
  'mashup',
  'speed up',
  'slow',
];

function containsStyleTerm(s: string): boolean {
  const t = s.toLowerCase();
  return STYLE_TERMS.some(term => t.includes(term));
}

function extractStyleTerms(s: string): string[] {
  const t = s.toLowerCase();
  return STYLE_TERMS.filter(term => t.includes(term));
}

export class TrackResolver {
  private readonly multi: MultiSourceManager;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxResults: number;

  constructor(multi?: MultiSourceManager, opts?: { ttlMs?: number; maxResults?: number }) {
    this.multi = multi || new MultiSourceManager();
    this.ttlMs = opts?.ttlMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    this.maxResults = Math.max(1, Math.min(10, opts?.maxResults ?? 5));
  }

  private cacheKey(title: string, artists: string[], durationMs?: number): string {
    const keyTitle = norm(title);
    const keyArtists = artists.map(a => norm(a)).sort().join(',');
    const dur = toSeconds(durationMs) ?? 0;
    return `${keyTitle}|${keyArtists}|${dur}`;
  }

  private getCached(key: string): TrackResolverResult | null {
    const e = this.cache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    const out: TrackResolverResult = { url: e.url, confidence: e.confidence, title: e.title };
    if (typeof e.creator === 'string') out.creator = e.creator;
    if (typeof e.duration === 'number') out.duration = e.duration;
    return out;
  }

  private setCached(key: string, r: TrackResolverResult): void {
    this.cache.set(key, { ...r, ts: Date.now() });
  }

  async resolveToYouTube(
    candidate: { title: string; artists: string[]; durationMs?: number },
    opts?: { userQuery?: string }
  ): Promise<TrackResolverResult | null> {
    const key = this.cacheKey(candidate.title, candidate.artists, candidate.durationMs);
    const cached = this.getCached(key);
    if (cached) {
      logEvent('track_resolver_cache_hit', { title: candidate.title });
      return cached;
    }

    const mainArtist = candidate.artists[0] || '';
    const extraTerms = typeof opts?.userQuery === 'string' ? extractStyleTerms(opts!.userQuery!) : [];
    const baseQuery = `${mainArtist} - ${candidate.title}${extraTerms.length ? ' ' + extraTerms.join(' ') : ''}`.slice(0, 180);
    const query = normalizeTitle(baseQuery);

    logEvent('track_resolver_search_started', { query, max: this.maxResults });

    const results: MusicSource[] = await this.multi.search(query, this.maxResults);
    if (!results || results.length === 0) {
      logWarning('track_resolver_no_results', { query });
      return null;
    }

    const desiredDur = toSeconds(candidate.durationMs);
    const titleNorm = norm(candidate.title);
    const artistsNorm = candidate.artists.map(a => norm(a));
    const allowedTerms = new Set<string>([
      ...extractStyleTerms(candidate.title),
      ...(extraTerms || [])
    ]);

    let best: TrackResolverResult | null = null;
    let bestScore = -Infinity;
    for (const r of results) {
      if (r.service !== 'youtube') continue;
      const ctx: { titleNorm: string; artistsNorm: string[]; desiredDur?: number; allowedTerms?: ReadonlyArray<string> } = { titleNorm, artistsNorm };
      if (typeof desiredDur === 'number') ctx.desiredDur = desiredDur;
      if (allowedTerms.size > 0) ctx.allowedTerms = Array.from(allowedTerms);
      const s = this.score(r, ctx);
      if (s > bestScore) {
        bestScore = s;
        const chosen: TrackResolverResult = {
          url: r.url,
          confidence: Math.max(0, Math.min(1, s)),
          title: r.title,
        };
        if (typeof r.creator === 'string') chosen.creator = r.creator;
        if (typeof r.duration === 'number') chosen.duration = r.duration;
        best = chosen;
      }
    }

    if (best) {
      this.setCached(key, best);
      logEvent('track_resolver_selected', { query, confidence: best.confidence, url: best.url });
    }
    return best;
  }

  private score(
    result: MusicSource,
    ctx: { titleNorm: string; artistsNorm: string[]; desiredDur?: number; allowedTerms?: ReadonlyArray<string> }
  ): number {
    let score = 0;
    const rTitle = norm(result.title || '');
    const rCreator = norm(result.creator || '');

    // Title inclusion
    if (rTitle.includes(ctx.titleNorm)) score += 0.4;

    // Artist match boost (creator or title contains artist)
    const artistHit = ctx.artistsNorm.some(a => a && (rCreator.includes(a) || rTitle.includes(a)));
    if (artistHit) score += 0.3;

    // Duration proximity
    if (typeof ctx.desiredDur === 'number' && typeof result.duration === 'number' && result.duration > 0) {
      const delta = Math.abs(result.duration - ctx.desiredDur);
      // Within 7s window boosts linearly
      if (delta <= 7) {
        score += 0.3 * (1 - delta / 7);
      } else if (delta <= 12) {
        score += 0.1 * (1 - (delta - 7) / 5);
      } else {
        score -= 0.3; // too far off
      }
    }

    // Penalize style terms only if not requested/allowed; small boost if explicitly allowed and present
    const resultHasStyle = containsStyleTerm(rTitle);
    const requested = (ctx.allowedTerms || []).some(t => rTitle.includes(t));
    if (resultHasStyle && !requested && !containsStyleTerm(ctx.titleNorm)) {
      score -= 0.4;
    } else if (resultHasStyle && requested) {
      score += 0.1; // explicit intent for style variant
    }
    // Small boost for topic/official cues
    if (/\btopic\b/i.test(result.creator || '') || /provided to youtube/i.test(result.title || '')) {
      score += 0.1;
    }

    return score;
  }
}
