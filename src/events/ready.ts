import { Client, Events } from 'discord.js';
import path from 'path';
import { logEvent } from '../utils/logger';
import { getRandomPhrase } from '../utils/discord';
import { PresenceManager } from '../services/PresenceManager';
import { loadCommandPayloads, registerCommands } from '../utils/registerCommands';
import { botConfig } from '../config';

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client: Client<true>) {
    const readyMessage = getRandomPhrase('ready');

    console.log(`🎵 ${readyMessage}`);
    console.log(`🧚‍♀️ Conectada como ${client.user.tag}`);
    console.log(
      `🎭 Ativa em ${client.guilds.cache.size} servidor${client.guilds.cache.size !== 1 ? 'es' : ''}`,
    );

    logEvent('bot_ready', {
      botTag: client.user.tag,
      botId: client.user.id,
      guildCount: client.guilds.cache.size,
      userCount: client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0),
    });

    // Auto-register slash commands on every boot.
    // Guild mode is instantaneous; global mode has ~1h propagation.
    // Failure is non-fatal: the bot keeps running with the previously registered commands.
    try {
      const commandsPath = path.join(__dirname, '..', 'commands');
      const payloads = loadCommandPayloads(commandsPath);
      const result = await registerCommands(botConfig, payloads);

      const modeLabel = result.mode === 'guild' ? `guild ${result.guildId}` : 'global';

      console.log(`✅ ${result.count} comandos registrados (${modeLabel})`);
      logEvent('commands_registered', {
        count: result.count,
        mode: result.mode,
        ...(result.guildId ? { guildId: result.guildId } : {}),
      });
    } catch (error) {
      // Non-fatal: log and continue. The bot still works with its last registered commands.
      console.error('⚠️  Falha ao registrar comandos no boot (nao critico):', error);
      logEvent('commands_register_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Iniciar presença ociosa rotativa (frases de silêncio) até que uma faixa comece
    try {
      PresenceManager.startIdleCycle();
      logEvent('bot_presence_idle_cycle_started', {});
    } catch (error) {
      console.error('Erro ao iniciar presença ociosa:', error);
    }
  },
};
