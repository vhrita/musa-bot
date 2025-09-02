import { Events, Interaction } from 'discord.js';
import { logEvent, logError } from '../utils/logger';
import { createMusaEmbed, safeReply, MusaColors, MusaEmojis } from '../utils/discord';

export default {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction) {
    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands?.get(interaction.commandName);
    const musicManager = interaction.client.musicManager;

    if (!command) {
      logError('Command not found', new Error(`Command ${interaction.commandName} not found`), {
        commandName: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId
      });
      
      const embed = createMusaEmbed({
        title: 'Comando Não Encontrado',
        description: `${MusaEmojis.warning} Comando \`${interaction.commandName}\` não foi encontrado! ${MusaEmojis.notes}`,
        color: MusaColors.error
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
        channelId: interaction.channelId
      });

      await command.execute(interaction, musicManager);

      logEvent('command_completed', {
        commandName: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId
      });

    } catch (error) {
      logError('Command execution failed', error as Error, {
        commandName: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId
      });

      const embed = createMusaEmbed({
        title: 'Erro no Comando',
        description: `${MusaEmojis.warning} Ops! Algo desafinou durante a execução do comando! Tente novamente! ${MusaEmojis.notes}`,
        color: MusaColors.error
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
          guildId: interaction.guildId
        });
      }
    }
  },
};
