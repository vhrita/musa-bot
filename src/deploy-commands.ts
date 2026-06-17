import path from 'path';
import { botConfig } from './config';
import { loadCommandPayloads, registerCommands } from './utils/registerCommands';

const commandsPath = path.join(__dirname, 'commands');
const commands = loadCommandPayloads(commandsPath);

(async () => {
  try {
    console.log(`🚀 Started refreshing ${commands.length} application (/) commands.`);

    const result = await registerCommands(botConfig, commands);

    if (result.mode === 'guild') {
      console.log(`✅ Successfully reloaded ${result.count} guild (/) commands for guild ${result.guildId}.`);
      console.log(`⚡ Guild commands appear immediately in Discord.`);
    } else {
      console.log(`✅ Successfully reloaded ${result.count} global (/) commands.`);
      console.log('⏰ Global commands may take up to 1 hour to appear in Discord.');
    }

    console.log('\n📋 Registered commands:');
    (commands as any[]).forEach((cmd) => {
      console.log(`  - /${cmd.name}: ${cmd.description}`);
    });
  } catch (error) {
    console.error('❌ Error registering commands:', error);
    process.exit(1);
  }
})();
