export interface MusicSource {
  title: string;
  url: string;
  duration?: number;
  creator?: string;
  service: ServiceType;
  isLiveStream?: boolean;
  thumbnail?: string;
}

export interface QueuedSong extends MusicSource {
  requestedBy: string;
  addedAt: Date;
}

export interface GuildMusicData {
  queue: QueuedSong[];
  currentSong: QueuedSong | null;
  currentSongStartedAt?: number; // epoch ms when playback started
  recentlyPlayed?: QueuedSong[];
  lastShuffle?: { by: string; byId?: string; at: number };
  lastAdded?: { by: string; byId?: string; at: number };
  volume: number;
  isPlaying: boolean;
  isPaused: boolean;
  loopMode: LoopMode;
  inactivityTimer?: ReturnType<typeof setTimeout>;
  emptyChannelTimer?: ReturnType<typeof setTimeout>;
}

export type ServiceType = 'youtube' | 'internet_archive' | 'radio' | 'spotify';

export type LoopMode = 'off' | 'song' | 'queue';

export interface ServiceConfig {
  enabled: boolean;
  priority: number;
  maxResults: number;
}

export interface BotConfig {
  token: string;
  clientId: string;
  prefix: string;
  musaChannelId: string | undefined;
  // Optional deployment/runtime extras
  guildId?: string;               // for deploy-commands convenience
  resolverUrl?: string;           // external YouTube resolver base URL
  ytdlpCookies?: string;          // path to yt-dlp cookies
  ytdlpProxy?: string;            // proxy for yt-dlp
  services: {
    youtube: ServiceConfig;
    internetArchive: ServiceConfig;
    radio: ServiceConfig;
  };
  logging: {
    level: string;
    maxSizeBytes?: number;
    maxFiles?: number;
  };
  music: {
    searchTimeout: number;
    maxQueueSize: number;
    inactivityTimeout: number;
    emptyChannelTimeout: number;
    // Prefetching configuration
    prefetchEnabled?: boolean;
    prefetchCount?: number; // how many upcoming songs to prefetch
    prefetchAll?: boolean;  // prefetch entire queue (caution)
    streamCacheTTL?: number; // ms TTL for cached stream URLs
  };
}

export interface CommandContext {
  guildId: string;
  userId: string;
  channelId: string;
  userDisplayName: string;
}

// Extend Discord.js Client to include music manager
declare module 'discord.js' {
  interface Client {
    commands: Collection<string, any>;
    musicManager: MusicManager;
  }
}

// Import for type declaration (type-only to avoid runtime cycles)
import type { Collection } from 'discord.js';
import type { MusicManager } from '../services/MusicManager';
