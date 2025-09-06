import { config } from 'dotenv';
import { loadBotConfig } from './schema';

// Load environment variables
config();

export const botConfig = loadBotConfig();
