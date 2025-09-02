import axios from 'axios';
import { BaseMusicService } from './BaseMusicService';
import { MusicSource } from '../types/music';
import { logEvent, logError } from '../utils/logger';

interface ArchiveItem {
  identifier: string;
  title: string;
  creator?: string;
  description?: string;
  downloads?: number;
  item_size?: number;
}

interface ArchiveFile {
  name: string;
  format: string;
  size?: string;
  length?: string;
}

export class InternetArchiveService extends BaseMusicService {
  private readonly baseUrl = 'https://archive.org';
  private readonly searchUrl = `${this.baseUrl}/advancedsearch.php`;

  constructor(priority: number, enabled: boolean) {
    super('internet_archive', priority, enabled);
  }

  async search(query: string, maxResults = 3): Promise<MusicSource[]> {
    try {
      logEvent('internet_archive_search_started', { query, maxResults });

      if (!this.enabled) {
        logEvent('internet_archive_service_disabled');
        return [];
      }

      const searchParams = {
        q: `title:(${query}) AND mediatype:audio AND format:(MP3 OR mp3)`,
        fl: 'identifier,title,creator,description,downloads,item_size',
        rows: maxResults * 2, // Get more to filter quality
        page: 1,
        output: 'json',
        sort: 'downloads desc' // Sort by popularity
      };

      const response = await axios.get(this.searchUrl, { 
        params: searchParams,
        timeout: 10000 
      });

      const items: ArchiveItem[] = response.data.response?.docs || [];
      
      if (items.length === 0) {
        logEvent('internet_archive_no_results', { query });
        return [];
      }

      // Process items and get audio files
      const results: MusicSource[] = [];
      
      for (const item of items.slice(0, maxResults)) {
        try {
          const audioSource = await this.getAudioFromItem(item);
          if (audioSource) {
            results.push(audioSource);
          }
        } catch (error) {
          logError('Failed to process Internet Archive item', error as Error, { 
            identifier: item.identifier 
          });
        }
      }

      logEvent('internet_archive_search_completed', { 
        query, 
        itemsFound: items.length, 
        resultsReturned: results.length 
      });

      return results;
    } catch (error) {
      logError('Internet Archive search failed', error as Error, { query, maxResults });
      return [];
    }
  }

  private async getAudioFromItem(item: ArchiveItem): Promise<MusicSource | null> {
    try {
      // Get item details to find audio files
      const metadataUrl = `${this.baseUrl}/metadata/${item.identifier}`;
      const response = await axios.get(metadataUrl, { timeout: 5000 });
      
      const files: ArchiveFile[] = response.data.files || [];
      
      // Find the best audio file (prefer MP3, avoid very small files)
      const audioFile = this.selectBestAudioFile(files);
      
      if (!audioFile) {
        return null;
      }

      const audioUrl = `${this.baseUrl}/download/${item.identifier}/${audioFile.name}`;
      
      // Parse duration if available
      let duration: number | undefined;
      if (audioFile.length) {
        const parts = audioFile.length.split(':');
        if (parts.length === 2 && parts[0] && parts[1]) {
          duration = parseInt(parts[0]) * 60 + parseInt(parts[1]);
        } else if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
          duration = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
        }
      }

      const sourceData: Parameters<typeof this.createMusicSource>[0] = {
        title: this.cleanTitle(item.title),
        url: audioUrl,
        thumbnail: `${this.baseUrl}/services/img/${item.identifier}`,
      };

      if (item.creator !== undefined) {
        sourceData.creator = item.creator;
      }

      if (duration !== undefined) {
        sourceData.duration = duration;
      }

      return this.createMusicSource(sourceData);
    } catch (error) {
      logError('Failed to get audio from Internet Archive item', error as Error, { 
        identifier: item.identifier 
      });
      return null;
    }
  }

  private selectBestAudioFile(files: ArchiveFile[]): ArchiveFile | null {
    // Filter for audio files
    const audioFiles = files.filter(file => 
      file.format?.toLowerCase().includes('mp3') || 
      file.name?.toLowerCase().endsWith('.mp3')
    );

    if (audioFiles.length === 0) {
      return null;
    }

    // Sort by quality preferences
    const sortedFiles = [...audioFiles].sort((a, b) => {
      // Prefer files with duration info
      if (a.length && !b.length) return -1;
      if (!a.length && b.length) return 1;

      // Prefer larger files (better quality)
      const sizeA = this.parseFileSize(a.size);
      const sizeB = this.parseFileSize(b.size);
      
      if (sizeA && sizeB) {
        return sizeB - sizeA;
      }

      // Fallback to name comparison
      return a.name.localeCompare(b.name);
    });

    // Return the best file, but avoid extremely small files (likely not music)
    const bestFile = sortedFiles[0];
    const fileSize = this.parseFileSize(bestFile?.size);
    
    // Skip files smaller than 1MB (likely not full songs)
    if (fileSize && fileSize < 1000000) {
      return null;
    }

    return bestFile || null;
  }

  private parseFileSize(sizeStr?: string): number | null {
    if (!sizeStr) return null;
    
    const size = parseFloat(sizeStr);
    return isNaN(size) ? null : size;
  }
}
