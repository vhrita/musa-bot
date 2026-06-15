import { Events, Interaction } from 'discord.js';
import { logEvent, logError } from '../utils/logger';
import { createMusaEmbed, safeReply, MusaColors, MusaEmojis } from '../utils/discord';

// In-memory cooldown map — scoped to this module, no globals
const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 2000;

export default {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction) {
    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands?.get(interaction.commandName);
    const musicManager = interaction.client.musicManager;

    // Cooldown check: rate-limit per user+command to prevent spam
    const cooldownKey = `${interaction.user.id}:${interaction.commandName}`;
    const now = Date.now();
    const lastUsed = cooldowns.get(cooldownKey) ?? 0;
    if (now - lastUsed < COOLDOWN_MS) {
      try {
        await interaction.reply({
          content: 'Aguarde um instante antes de usar este comando novamente.',
          ephemeral: true,
        });
      } catch {
        // ignore reply errors (interaction may have expired)
      }
      return;
    }
    cooldowns.set(cooldownKey, now);

    if (!command) {
      logError('Command not found', new Error(`Command ${interaction.commandName} not found`), {
        commandName: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });

      const embed = createMusaEmbed({
        title: 'Comando Não Encontrado',
        description: `${MusaEmojis.warning} Comando \`${interaction.commandName}\` não foi encontrado! ${MusaEmojis.notes}`,
        color: MusaColors.error,
      });

      await safeReply(interaction, { embeds: [embed] }, true);
      return;
    }

    try {
      logEvent('command_started', {
        commandName: interaction.commandName,
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });

      await command.execute(interaction, musicManager);

      logEvent('command_completed', {
        commandName: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
    } catch (error) {
      logError('Command execution failed', error as Error, {
        commandName: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });

      const embed = createMusaEmbed({
        title: 'Erro no Comando',
        description: `${MusaEmojis.warning} Ops! Algo desafinou durante a execução do comando! Tente novamente! ${MusaEmojis.notes}`,
        color: MusaColors.error,
      });

      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ embeds: [embed], ephemeral: true });
        } else {
          await interaction.reply({ embeds: [embed], ephemeral: true });
        }
      } catch (replyError) {
        logError('Failed to send error message', replyError as Error, {
          commandName: interaction.commandName,
          userId: interaction.user.id,
          guildId: interaction.guildId,
        });
      }
    }
  },
};
