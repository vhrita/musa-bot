import { Client, Events } from 'discord.js';
import { logEvent } from '../utils/logger';
import { getRandomPhrase } from '../utils/discord';

export default {
  name: Events.ClientReady,
  once: true,
  execute(client: Client<true>) {
    const readyMessage = getRandomPhrase('ready');
    
    console.log(`🎵 ${readyMessage}`);
    console.log(`🧚‍♀️ Conectada como ${client.user.tag}`);
    console.log(`🎭 Ativa em ${client.guilds.cache.size} servidor${client.guilds.cache.size !== 1 ? 'es' : ''}`);
    
    logEvent('bot_ready', {
      botTag: client.user.tag,
      botId: client.user.id,
      guildCount: client.guilds.cache.size,
      userCount: client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0)
    });

    // Definir status da Musa
    try {
      client.user?.setPresence({
        status: 'online',
        activities: [{
          name: 'melodias encantadas ✨',
          type: 2, // LISTENING
        }]
      });

      logEvent('bot_presence_set', {
        status: 'online',
        activity: 'melodias encantadas ✨'
      });
    } catch (error) {
      console.error('Erro ao definir presença:', error);
    }
  },
};
