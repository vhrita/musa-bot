/**
 * RadioService — serviço de rádio da Musa com Radio Browser API.
 *
 * Comportamento:
 *  1. Presets curados: atalhos de gênero com rótulos CORRETOS (verificados manualmente).
 *     Se a query bate um preset, busca na API pelo tag exato e retorna a mais votada.
 *  2. Busca on-demand: se a query não bate nenhum preset, pesquisa pelo nome da estação
 *     na Radio Browser API e retorna a mais popular (clickcount).
 *
 * Nota sobre codec: `createRadioResource` no MusicManager não força '-f mp3' (corrigido).
 * Estações AAC, OGG, HLS funcionam corretamente.
 */

import { BaseMusicService } from './BaseMusicService';
import { MusicSource } from '../types/music';
import { logEvent, logError, logWarning } from '../utils/logger';
import { searchByName, searchByTag, RadioBrowserStation } from './RadioBrowserService';

// ---------------------------------------------------------------------------
// Presets curados (rótulo → tag exata na Radio Browser)
// Apenas gêneros com rótulos CORRETOS e tags populares na API.
// ---------------------------------------------------------------------------
const GENRE_PRESETS: Record<string, { label: string; tag: string }> = {
  pop: { label: 'Pop', tag: 'pop' },
  rock: { label: 'Rock', tag: 'rock' },
  jazz: { label: 'Jazz', tag: 'jazz' },
  classical: { label: 'Classical', tag: 'classical' },
  electronic: { label: 'Electronic', tag: 'electronic' },
  chill: { label: 'Chill', tag: 'chillout' },
  lofi: { label: 'Lo-Fi', tag: 'lofi' },
  metal: { label: 'Metal', tag: 'metal' },
  hiphop: { label: 'Hip-Hop', tag: 'hip hop' },
  country: { label: 'Country', tag: 'country' },
  blues: { label: 'Blues', tag: 'blues' },
  reggae: { label: 'Reggae', tag: 'reggae' },
  latin: { label: 'Latin', tag: 'latin' },
  rnb: { label: 'R&B / Soul', tag: 'rnb' },
  ambient: { label: 'Ambient', tag: 'ambient' },
  news: { label: 'News / Talk', tag: 'news' },
};

function stationToMusicSource(service: RadioService, station: RadioBrowserStation): MusicSource {
  // Prefer the resolved URL (direct stream) over the original URL
  const url = station.url_resolved || station.url;
  const codecInfo = station.codec ? ` [${station.codec.toUpperCase()}]` : '';
  const bitrateInfo = station.bitrate > 0 ? ` ${station.bitrate}kbps` : '';

  const source: Parameters<RadioService['createMusicSource']>[0] = {
    title: `📻 ${station.name}${codecInfo}${bitrateInfo}`,
    url,
    creator: station.country ? `${station.country} • Radio Browser` : 'Radio Browser',
    isLiveStream: true,
  };
  if (station.favicon) {
    source.thumbnail = station.favicon;
  }
  return service.createMusicSource(source);
}

export class RadioService extends BaseMusicService {
  constructor(priority: number, enabled: boolean) {
    super('radio', priority, enabled);
  }

  /**
   * Busca uma estação de rádio por query.
   *
   * Fluxo:
   *  1. Normaliza a query.
   *  2. Se bate um preset de gênero → busca por tag, retorna a mais votada.
   *  3. Senão → busca por nome na API, retorna top-N por clickcount.
   */
  async search(query: string, maxResults = 1): Promise<MusicSource[]> {
    try {
      logEvent('radio_search_started', { query, maxResults });

      if (!this.enabled) {
        logEvent('radio_service_disabled');
        return [];
      }

      const q = query.toLowerCase().trim();
      const preset = GENRE_PRESETS[q];

      let stations: RadioBrowserStation[] = [];

      if (preset) {
        // Busca por tag (gênero curado)
        logEvent('radio_search_by_preset', { query: q, tag: preset.tag });
        stations = await searchByTag(preset.tag, Math.max(maxResults, 3));
      } else {
        // Busca por nome on-demand
        logEvent('radio_search_by_name', { query: q });
        stations = await searchByName(q, Math.max(maxResults, 5));
      }

      if (stations.length === 0) {
        logWarning('radio_no_stations_found', { query });
        return [];
      }

      // Limita ao maxResults e mapeia pra MusicSource
      const results = stations.slice(0, maxResults).map((s) => stationToMusicSource(this, s));

      logEvent('radio_search_completed', {
        query,
        preset: preset?.label ?? 'name-search',
        stationsFound: stations.length,
        resultsReturned: results.length,
      });

      return results;
    } catch (error) {
      logError('Radio search failed', error as Error, { query, maxResults });
      return [];
    }
  }

  /** Retorna os gêneros dos presets curados. */
  getAvailableGenres(): string[] {
    return Object.keys(GENRE_PRESETS);
  }

  /** Retorna os presets disponíveis com label + tag. */
  getPresets(): typeof GENRE_PRESETS {
    return GENRE_PRESETS;
  }

  // Exposing protected method for internal use in stationToMusicSource helper
  createMusicSource(data: {
    title: string;
    url: string;
    duration?: number;
    creator?: string;
    isLiveStream?: boolean;
    thumbnail?: string;
  }) {
    return super.createMusicSource(data);
  }
}
