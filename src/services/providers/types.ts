export type ProviderId = 'youtube' | 'ytm' | 'spotify';

export interface PlaylistItemCandidate {
  title: string;
  artists?: string[];
  creator?: string;
  durationMs?: number;
  provider: ProviderId;
  providerUrl: string; // canonical playlist or track URL at the provider
  youtubeVideoUrl?: string; // when already resolved (YT/YTM)
  thumbnailUrl?: string;
}

export interface PlaylistMeta {
  id: string;
  title?: string;
  total?: number;
  owner?: string;
  description?: string;
}

export interface PlaylistProvider {
  supports(url: string): boolean;
  getMeta(url: string): Promise<PlaylistMeta | null>;
  fetchItems(
    url: string,
    opts?: { limit?: number; offset?: number; pageSize?: number }
  ): AsyncGenerator<PlaylistItemCandidate>;
}

