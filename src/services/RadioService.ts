import { BaseMusicService } from './BaseMusicService';
import { MusicSource } from '../types/music';
import { logEvent, logError } from '../utils/logger';

interface RadioStation {
  name: string;
  url: string;
  genre: string;
  country?: string;
}

export class RadioService extends BaseMusicService {
  private readonly radioStations: Record<string, RadioStation[]> = {
    pop: [
      {
        name: 'Pop Hits Radio',
        url: 'https://ice.somafm.com/poptron-128-mp3',
        genre: 'pop',
        country: 'US'
      },
      {
        name: 'Today\'s Hits',
        url: 'https://ice.somafm.com/indiepop-128-mp3',
        genre: 'pop',
        country: 'US'
      }
    ],
    rock: [
      {
        name: 'Classic Rock Radio',
        url: 'https://ice.somafm.com/bootliquor-128-mp3',
        genre: 'rock',
        country: 'US'
      },
      {
        name: 'Rock Hits',
        url: 'https://ice.somafm.com/folkfwd-128-mp3',
        genre: 'rock',
        country: 'US'
      }
    ],
    jazz: [
      {
        name: 'Smooth Jazz',
        url: 'https://ice.somafm.com/groovesalad-128-mp3',
        genre: 'jazz',
        country: 'US'
      },
      {
        name: 'Jazz24',
        url: 'https://ice.somafm.com/thetrip-128-mp3',
        genre: 'jazz',
        country: 'US'
      }
    ],
    classical: [
      {
        name: 'Classical Music',
        url: 'https://ice.somafm.com/sonicuniverse-128-mp3',
        genre: 'classical',
        country: 'US'
      }
    ],
    electronic: [
      {
        name: 'Electronic Beats',
        url: 'https://ice.somafm.com/beatblender-128-mp3',
        genre: 'electronic',
        country: 'US'
      },
      {
        name: 'Drone Zone',
        url: 'https://ice.somafm.com/dronezone-128-mp3',
        genre: 'electronic',
        country: 'US'
      }
    ],
    chill: [
      {
        name: 'Chill Out',
        url: 'https://ice.somafm.com/groovesalad-128-mp3',
        genre: 'chill',
        country: 'US'
      }
    ],
    lofi: [
      {
        name: 'Lo-Fi Hip Hop',
        url: 'https://ice.somafm.com/beatblender-128-mp3',
        genre: 'lofi',
        country: 'US'
      }
    ]
  };

  constructor(priority: number, enabled: boolean) {
    super('radio', priority, enabled);
  }

  async search(query: string, maxResults = 3): Promise<MusicSource[]> {
    try {
      logEvent('radio_search_started', { query, maxResults });

      if (!this.enabled) {
        logEvent('radio_service_disabled');
        return [];
      }

      const genre = query.toLowerCase().trim();
      const stations = this.radioStations[genre] || [];

      if (stations.length === 0) {
        logEvent('radio_genre_not_found', { genre });
        return [];
      }

      const results = stations
        .slice(0, maxResults)
        .map(station => this.createMusicSource({
          title: `📻 ${station.name} (${station.genre.toUpperCase()})`,
          url: station.url,
          creator: 'Live Radio',
          isLiveStream: true,
        }));

      logEvent('radio_search_completed', { 
        genre, 
        stationsFound: stations.length, 
        resultsReturned: results.length 
      });

      return results;
    } catch (error) {
      logError('Radio search failed', error as Error, { query, maxResults });
      return [];
    }
  }

  getAvailableGenres(): string[] {
    return Object.keys(this.radioStations);
  }

  getStationsByGenre(genre: string): RadioStation[] {
    return this.radioStations[genre.toLowerCase()] || [];
  }
}
