import { REST, Routes } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { botConfig } from './config';

const commands = [];
const commandsPath = path.join(__dirname, 'commands');

// Determine file extension based on whether we're running compiled JS or TS
const isCompiled = __filename.endsWith('.js');
const fileExtension = isCompiled ? '.js' : '.ts';

const commandFiles = fs.readdirSync(commandsPath).filter(file => 
    file.endsWith(fileExtension) && file !== 'index' + fileExtension
);

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    const commandData = command.default || command;
    
    if ('data' in commandData && 'execute' in commandData) {
        commands.push(commandData.data.toJSON());
        console.log(`✅ Loaded command: ${commandData.data.name}`);
    } else {
        console.log(`⚠️  Skipped ${file}: Missing required data or execute property`);
    }
}

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(botConfig.token);

// Deploy commands
(async () => {
    try {
        console.log(`🚀 Started refreshing ${commands.length} application (/) commands.`);

        // Register commands globally (takes up to 1 hour to update)
        // For development, use guild-specific registration (instant)
        
        if (botConfig.guildId) {
            // Development: Register to specific guild (instant)
            const data = await rest.put(
                Routes.applicationGuildCommands(botConfig.clientId, botConfig.guildId),
                { body: commands },
            ) as any[];

            console.log(`✅ Successfully reloaded ${data.length} guild (/) commands for guild ${botConfig.guildId}.`);
            console.log(`⚡ Guild commands appear immediately in Discord.`);
        } else {
            // Production: Register globally
            const data = await rest.put(
                Routes.applicationCommands(botConfig.clientId),
                { body: commands },
            ) as any[];

            console.log(`✅ Successfully reloaded ${data.length} global (/) commands.`);
            console.log('⏰ Global commands may take up to 1 hour to appear in Discord.');
        }

        console.log('\n📋 Registered commands:');
        commands.forEach((cmd: any) => {
            console.log(`  - /${cmd.name}: ${cmd.description}`);
        });

    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
})();
