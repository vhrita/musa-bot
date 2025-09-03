import { config } from 'dotenv';
import { BotConfig } from '../types/music';

// Load environment variables
config();

export const botConfig: BotConfig = {
  token: process.env.DISCORD_TOKEN || '',
  clientId: process.env.DISCORD_CLIENT_ID || '',
  prefix: process.env.PREFIX || '!',
  musaChannelId: process.env.MUSA_CHANNEL_ID,
  
  services: {
    youtube: {
      enabled: process.env.ENABLE_YOUTUBE?.toLowerCase() === 'true',
      priority: parseInt(process.env.YOUTUBE_PRIORITY || '3'),
      maxResults: parseInt(process.env.MAX_RESULTS_PER_SOURCE || '3'),
    },
    internetArchive: {
      enabled: process.env.ENABLE_INTERNET_ARCHIVE?.toLowerCase() !== 'false',
      priority: parseInt(process.env.INTERNET_ARCHIVE_PRIORITY || '2'),
      maxResults: parseInt(process.env.MAX_RESULTS_PER_SOURCE || '3'),
    },
    radio: {
      enabled: process.env.ENABLE_RADIO?.toLowerCase() !== 'false',
      priority: parseInt(process.env.RADIO_PRIORITY || '1'),
      maxResults: parseInt(process.env.MAX_RESULTS_PER_SOURCE || '3'),
    },
  },

  logging: {
    level: process.env.LOG_LEVEL || 'INFO',
  },

  music: {
    searchTimeout: parseInt(process.env.SEARCH_TIMEOUT_SECONDS || '10') * 1000,
    maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE || '100'),
    inactivityTimeout: parseInt(process.env.INACTIVITY_TIMEOUT || '60') * 1000,        // 1 minute default
    emptyChannelTimeout: parseInt(process.env.EMPTY_CHANNEL_TIMEOUT || '120') * 1000,  // 2 minutes default
  },
};

// Validate required config
if (!botConfig.token) {
  throw new Error('🎵 Musa precisa do token do Discord! Configure DISCORD_TOKEN no ambiente.');
}
