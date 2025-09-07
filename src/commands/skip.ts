import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { MusicManager } from '../services/MusicManager';
import { 
  createMusaEmbed, 
  safeReply, 
  MusaColors, 
  MusaEmojis,
  getServiceEmoji,
  truncateText
} from '../utils/discord';
import { logEvent, logError } from '../utils/logger';

export default {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('⏭️ Pula para a próxima música da playlist'),

  async execute(interaction: ChatInputCommandInteraction, musicManager: MusicManager): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
      const member = interaction.member as GuildMember;
      const guildId = interaction.guildId!;

      // Verificar se o usuário está no mesmo canal de voz
      const userVoiceChannel = member.voice.channel;
      const botVoiceConnection = musicManager.getVoiceConnection(guildId);
      
      if (!userVoiceChannel || !botVoiceConnection) {
        const embed = createMusaEmbed({
          title: 'Não Estou Tocando',
          description: `${MusaEmojis.skip} Não estou tocando música no momento! Não há nada para pular! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        });

        await safeReply(interaction, { embeds: [embed] }, true);
        return;
      }

      // Verificar se há música tocando
      const guildData = musicManager.getGuildMusicData(guildId);
      const currentSong = guildData.currentSong;
      
      if (!currentSong || (!guildData.isPlaying && !guildData.isPaused)) {
        const embed = createMusaEmbed({
          title: 'Nada Para Pular',
          description: `${MusaEmojis.skip} Não há música tocando no momento! Use \`/play\` para começar! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        });

        await safeReply(interaction, { embeds: [embed] }, true);
        return;
      }

      // Verificar se há próxima música
      const nextSong = guildData.queue[0];
      const hasNextSong = nextSong !== undefined;

      // Pular a música
      musicManager.skip(guildId);

      // Criar embed de confirmação
      const embed = createMusaEmbed({
        title: 'Música Pulada',
        description: `${MusaEmojis.skip} Pulei para o próximo compasso! ${hasNextSong ? 'Vamos continuar o ritmo!' : 'Era a última da playlist!'} ${MusaEmojis.notes}`,
        color: MusaColors.warning
      });

      // Adicionar informação da música pulada
      embed.addFields([
        {
          name: `${MusaEmojis.previous} Música Pulada`,
          value: `${getServiceEmoji(currentSong.service)} **${truncateText(currentSong.title, 50)}**`,
          inline: false
        }
      ]);

      if (currentSong.creator) {
        embed.addFields([
          {
            name: `${MusaEmojis.microphone} Artista`,
            value: truncateText(currentSong.creator, 40),
            inline: true
          }
        ]);
      }

      // Adicionar informação da próxima música se houver
      if (hasNextSong) {
        embed.addFields([
          {
            name: `${MusaEmojis.play} Próxima Música`,
            value: `${getServiceEmoji(nextSong.service)} **${truncateText(nextSong.title, 50)}**`,
            inline: false
          }
        ]);

        if (nextSong.creator) {
          embed.addFields([
            {
              name: `${MusaEmojis.microphone} Próximo Artista`,
              value: truncateText(nextSong.creator, 40),
              inline: true
            }
          ]);
        }

        embed.addFields([
          {
            name: `${MusaEmojis.queue} Restantes na Fila`,
            value: `${guildData.queue.length - 1} música${guildData.queue.length - 1 !== 1 ? 's' : ''}`,
            inline: true
          }
        ]);
      } else {
        embed.addFields([
          {
            name: `${MusaEmojis.stop} Fim da Playlist`,
            value: 'Era a última música da fila',
            inline: true
          }
        ]);

        embed.setFooter({ 
          text: `${MusaEmojis.play} Use /play para adicionar mais músicas` 
        });
      }

      await safeReply(interaction, { embeds: [embed] });

      logEvent('music_skipped_by_command', {
        guildId,
        userId: member.id,
        skippedSong: currentSong.title,
        nextSong: nextSong?.title,
        remainingInQueue: guildData.queue.length - (hasNextSong ? 1 : 0)
      });

    } catch (error) {
      logError('Skip command failed', error as Error, {
        guildId: interaction.guildId,
        userId: interaction.user.id
      });

      const embed = createMusaEmbed({
        title: 'Erro Musical',
        description: `${MusaEmojis.warning} Ops! Algo desafinou ao tentar pular a música! ${MusaEmojis.notes}`,
        color: MusaColors.error
      });

      await safeReply(interaction, { embeds: [embed] });
    }
  },
};
