import { MusicSource, ServiceType } from '../types/music';
import { BaseMusicService } from './BaseMusicService';
import { RadioService } from './RadioService';
import { InternetArchiveService } from './InternetArchiveService';
import { YouTubeService } from './YouTubeService';
import { botConfig } from '../config';
import { logEvent, logError, logWarning } from '../utils/logger';

export class MultiSourceManager {
  private readonly services: BaseMusicService[] = [];
  private enabledServices: BaseMusicService[] = [];

  constructor() {
    this.initializeServices();
  }

  private initializeServices(): void {
    // Initialize all services based on config
    const services = [
      new RadioService(
        botConfig.services.radio.priority,
        botConfig.services.radio.enabled
      ),
      new InternetArchiveService(
        botConfig.services.internetArchive.priority,
        botConfig.services.internetArchive.enabled
      ),
      new YouTubeService(
        botConfig.services.youtube.priority,
        botConfig.services.youtube.enabled
      ),
    ];

    this.services.push(...services);

    // Filter enabled services and sort by priority
    this.enabledServices = this.services
      .filter(service => service.isEnabled())
      .sort((a, b) => a.getPriority() - b.getPriority());

    logEvent('multi_source_manager_initialized', {
      totalServices: this.services.length,
      enabledServices: this.enabledServices.length,
      enabledServiceNames: this.enabledServices.map(s => s.getServiceName())
    });

    if (this.enabledServices.length === 0) {
      logWarning('No music services are enabled');
    }
  }

  async search(query: string, maxResultsPerService?: number): Promise<MusicSource[]> {
    if (this.enabledServices.length === 0) {
      logWarning('No enabled services available for search', { query });
      return [];
    }

    logEvent('multi_source_search_started', {
      query,
      maxResultsPerService,
      enabledServices: this.enabledServices.length
    });

    const searchPromises = this.enabledServices.map(async (service) => {
      try {
        const results = await service.search(query, maxResultsPerService);
        logEvent('service_search_completed', {
          service: service.getServiceName(),
          query,
          resultsCount: results.length
        });
        return results;
      } catch (error) {
        logError(`Service search failed: ${service.getServiceName()}`, error as Error, {
          query,
          service: service.getServiceName()
        });
        return [];
      }
    });

    try {
      const allResults = await Promise.all(searchPromises);
      const combinedResults = allResults.flat();

      // Sort results by service priority and add diversity
      const sortedResults = this.sortAndDiversifyResults(combinedResults);

      logEvent('multi_source_search_completed', {
        query,
        totalResults: sortedResults.length,
        resultsByService: this.getResultsCountByService(combinedResults)
      });

      return sortedResults;
    } catch (error) {
      logError('Multi-source search failed', error as Error, { query });
      return [];
    }
  }

  async searchRadio(genre: string, maxResults?: number): Promise<MusicSource[]> {
    const radioService = this.enabledServices.find(
      service => service.getServiceName() === 'radio'
    ) as RadioService | undefined;

    if (!radioService) {
      logWarning('Radio service not available', { genre });
      return [];
    }

    try {
      const results = await radioService.search(genre, maxResults);
      logEvent('radio_specific_search_completed', {
        genre,
        resultsCount: results.length
      });
      return results;
    } catch (error) {
      logError('Radio search failed', error as Error, { genre });
      return [];
    }
  }

  getAvailableRadioGenres(): string[] {
    const radioService = this.enabledServices.find(
      service => service.getServiceName() === 'radio'
    ) as RadioService | undefined;

    return radioService?.getAvailableGenres() || [];
  }

  private sortAndDiversifyResults(results: MusicSource[]): MusicSource[] {
    if (results.length === 0) return [];

    // Group results by service
    const resultsByService = results.reduce((acc, result) => {
      const service = result.service;
      if (!acc[service]) {
        acc[service] = [];
      }
      acc[service].push(result);
      return acc;
    }, {} as Record<ServiceType, MusicSource[]>);

    // Interleave results to promote diversity
    const diversifiedResults: MusicSource[] = [];
    const serviceKeys = Object.keys(resultsByService) as ServiceType[];
    
    // Sort services by priority
    const sortedServices = [...serviceKeys].sort((a, b) => {
      const serviceA = this.services.find(s => s.getServiceName() === a);
      const serviceB = this.services.find(s => s.getServiceName() === b);
      
      const priorityA = serviceA?.getPriority() || 999;
      const priorityB = serviceB?.getPriority() || 999;
      
      return priorityA - priorityB;
    });

    // Interleave results from different services
    const maxResultsPerService = Math.max(...Object.values(resultsByService).map(arr => arr.length));
    
    // Track per-service indices
    const serviceIndices: Record<ServiceType, number> = {};
    for (const service of sortedServices) {
      serviceIndices[service] = 0;
    }

    let added = true;
    while (added) {
      added = false;
      for (const service of sortedServices) {
        const serviceResults = resultsByService[service];
        const idx = serviceIndices[service];
        if (serviceResults && idx < serviceResults.length) {
          diversifiedResults.push(serviceResults[idx]);
          serviceIndices[service]++;
          added = true;
        }
      }
    }

    return diversifiedResults;
  }

  private getResultsCountByService(results: MusicSource[]): Record<string, number> {
    return results.reduce((acc, result) => {
      const service = result.service;
      acc[service] = (acc[service] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }

  getEnabledServices(): BaseMusicService[] {
    return [...this.enabledServices];
  }

  getService(serviceName: ServiceType): BaseMusicService | null {
    return this.services.find(service => service.getServiceName() === serviceName) || null;
  }

  isServiceEnabled(serviceName: ServiceType): boolean {
    return this.enabledServices.some(service => service.getServiceName() === serviceName);
  }
}
