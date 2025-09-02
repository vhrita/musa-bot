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
  musaChannelId: string;
  services: {
    youtube: ServiceConfig;
    internetArchive: ServiceConfig;
    radio: ServiceConfig;
  };
  logging: {
    level: string;
  };
  music: {
    searchTimeout: number;
    maxQueueSize: number;
    inactivityTimeout: number;
    emptyChannelTimeout: number;
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

// Import for type declaration
import { Collection } from 'discord.js';
import { MusicManager } from '../services/MusicManager';
