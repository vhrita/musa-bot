import { Client, GatewayIntentBits, Collection } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { botConfig } from './config';
import { logger } from './utils/logger';
import { MusicManager } from './services/MusicManager';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

// Initialize command collection
client.commands = new Collection();

// Initialize music manager
const musicManager = new MusicManager();
client.musicManager = musicManager;

// Load commands
const loadCommands = async () => {
    const commandsPath = path.join(__dirname, 'commands');
    
    // Determine file extension based on whether we're running compiled JS or TS
    const isCompiled = __filename.endsWith('.js');
    const fileExtension = isCompiled ? '.js' : '.ts';
    
    const commandFiles = fs.readdirSync(commandsPath).filter(file => 
        file.endsWith(fileExtension) && file !== 'index' + fileExtension
    );

    let loadedCommands = 0;
    const commandNames: string[] = [];

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        try {
            const command = require(filePath);
            const commandData = command.default || command;
            
            if ('data' in commandData && 'execute' in commandData) {
                client.commands.set(commandData.data.name, commandData);
                commandNames.push(commandData.data.name);
                loadedCommands++;
            } else {
                logger.warn(`🎵 command_load_warning`, {
                    file,
                    reason: 'Missing required data or execute property'
                });
            }
        } catch (error) {
            logger.error(`🎵 command_load_error`, {
                file,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    logger.info(`🎵 commands_loaded`, {
        commandCount: loadedCommands,
        commandNames
    });
};

// Load events
const loadEvents = async () => {
    const eventsPath = path.join(__dirname, 'events');
    
    // Check if events directory exists
    if (!fs.existsSync(eventsPath)) {
        logger.info(`🎵 events_loaded`, {
            eventCount: 0,
            reason: 'Events directory does not exist'
        });
        return;
    }
    
    // Determine file extension based on whether we're running compiled JS or TS
    const isCompiled = __filename.endsWith('.js');
    const fileExtension = isCompiled ? '.js' : '.ts';
    
    const eventFiles = fs.readdirSync(eventsPath).filter(file => 
        file.endsWith(fileExtension)
    );

    let loadedEvents = 0;
    const eventNames: string[] = [];

    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);
        try {
            const event = require(filePath);
            const eventData = event.default || event;
            
            if (eventData.once) {
                client.once(eventData.name, (...args) => eventData.execute(...args, musicManager));
            } else {
                client.on(eventData.name, (...args) => eventData.execute(...args, musicManager));
            }
            
            eventNames.push(eventData.name);
            loadedEvents++;
        } catch (error) {
            logger.error(`🎵 event_load_error`, {
                file,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    logger.info(`🎵 events_loaded`, {
        eventCount: loadedEvents,
        eventNames
    });
};

const startBot = async () => {
    try {
        logger.info(`🎵 bot_startup_initiated`);
        
        await loadCommands();
        await loadEvents();
        
        await client.login(botConfig.token);
        
    } catch (error) {
        logger.error(`🎵 bot_startup_error`, {
            error: error instanceof Error ? error.message : String(error)
        });
        process.exit(1);
    }
};

// Graceful shutdown
const gracefulShutdown = (signal: string) => {
    logger.info(`🎵 bot_shutdown_initiated`, { signal });
    client.destroy();
    process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start the bot
startBot();
