import { MusicSource, ServiceType } from '../types/music';

export abstract class BaseMusicService {
  protected readonly serviceName: ServiceType;
  protected readonly priority: number;
  protected readonly enabled: boolean;

  constructor(serviceName: ServiceType, priority: number, enabled: boolean) {
    this.serviceName = serviceName;
    this.priority = priority;
    this.enabled = enabled;
  }

  abstract search(query: string, maxResults?: number): Promise<MusicSource[]>;
  
  isEnabled(): boolean {
    return this.enabled;
  }

  getPriority(): number {
    return this.priority;
  }

  getServiceName(): ServiceType {
    return this.serviceName;
  }

  protected createMusicSource(data: {
    title: string;
    url: string;
    duration?: number;
    creator?: string;
    isLiveStream?: boolean;
    thumbnail?: string;
  }): MusicSource {
    const source: MusicSource = {
      title: data.title,
      url: data.url,
      service: this.serviceName,
      isLiveStream: data.isLiveStream || false,
    };

    if (data.duration !== undefined) {
      source.duration = data.duration;
    }

    if (data.creator !== undefined) {
      source.creator = data.creator;
    }

    if (data.thumbnail !== undefined) {
      source.thumbnail = data.thumbnail;
    }

    return source;
  }

  protected validateUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  protected cleanTitle(title: string): string {
    return title
      .replace(/[[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
