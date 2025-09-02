import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { MusicManager } from '../services/MusicManager';
import { 
  createMusaEmbed, 
  safeReply, 
  MusaColors, 
  MusaEmojis,
  getRandomPhrase
} from '../utils/discord';
import { logEvent, logError } from '../utils/logger';

export default {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('⏹️ Para a música e limpa a playlist'),

  async execute(interaction: ChatInputCommandInteraction, musicManager: MusicManager): Promise<void> {
    try {
      const member = interaction.member as GuildMember;
      const guildId = interaction.guildId!;

      // Verificar se o usuário está no mesmo canal de voz
      const userVoiceChannel = member.voice.channel;
      const botVoiceConnection = musicManager.getVoiceConnection(guildId);
      
      if (!userVoiceChannel || !botVoiceConnection) {
        const embed = createMusaEmbed({
          title: 'Não Estou Tocando',
          description: `${MusaEmojis.stop} Não estou tocando música no momento! Não há nada para parar! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        });

        await safeReply(interaction, { embeds: [embed] }, true);
        return;
      }

      // Obter dados atuais antes de parar
      const guildData = musicManager.getGuildMusicData(guildId);
      const currentSong = guildData.currentSong;
      const queueLength = guildData.queue.length;
      const wasPlaying = guildData.isPlaying || guildData.isPaused;

      if (!wasPlaying && !currentSong && queueLength === 0) {
        const embed = createMusaEmbed({
          title: 'Nada Para Parar',
          description: `${MusaEmojis.stop} Não há música tocando ou na fila! O silêncio já reina! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        });

        await safeReply(interaction, { embeds: [embed] }, true);
        return;
      }

      // Parar a música e limpar a fila
      musicManager.stop(guildId);

      // Desconectar do canal de voz
      await musicManager.leaveVoiceChannel(guildId);

      // Criar embed de confirmação
      const embed = createMusaEmbed({
        title: 'Música Parada',
        description: `${MusaEmojis.stop} ${getRandomPhrase('stopped')}`,
        color: MusaColors.error
      });

      if (currentSong) {
        embed.addFields([
          {
            name: `${MusaEmojis.notes} Última Música`,
            value: `**${currentSong.title}**`,
            inline: false
          }
        ]);

        if (currentSong.creator) {
          embed.addFields([
            {
              name: `${MusaEmojis.microphone} Artista`,
              value: currentSong.creator,
              inline: true
            }
          ]);
        }
      }

      if (queueLength > 0) {
        embed.addFields([
          {
            name: `${MusaEmojis.clear} Fila Limpa`,
            value: `Removidas **${queueLength}** música${queueLength > 1 ? 's' : ''} da fila`,
            inline: true
          }
        ]);
      }

      embed.addFields([
        {
          name: `${MusaEmojis.fairy} Desconectada`,
          value: 'Saí do canal de voz',
          inline: true
        }
      ]);

      embed.setFooter({ 
        text: `${MusaEmojis.play} Use /play para começar uma nova sessão musical` 
      });

      await safeReply(interaction, { embeds: [embed] });

      logEvent('music_stopped_by_command', {
        guildId,
        userId: member.id,
        lastSong: currentSong?.title,
        clearedQueueLength: queueLength,
        wasPlaying
      });

    } catch (error) {
      logError('Stop command failed', error as Error, {
        guildId: interaction.guildId,
        userId: interaction.user.id
      });

      const embed = createMusaEmbed({
        title: 'Erro Musical',
        description: `${MusaEmojis.warning} ${getRandomPhrase('error')}`,
        color: MusaColors.error
      });

      await safeReply(interaction, { embeds: [embed] });
    }
  },
};
