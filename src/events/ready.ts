import { Client, Events } from 'discord.js';
import { logEvent } from '../utils/logger';
import { getRandomPhrase } from '../utils/discord';
import { PresenceManager } from '../services/PresenceManager';

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

    // Iniciar presença ociosa rotativa (frases de silêncio) até que uma faixa comece
    try {
      PresenceManager.startIdleCycle();
      logEvent('bot_presence_idle_cycle_started', {});
    } catch (error) {
      console.error('Erro ao iniciar presença ociosa:', error);
    }
  },
};
