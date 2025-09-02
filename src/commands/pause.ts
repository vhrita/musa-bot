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
    .setName('pause')
    .setDescription('⏸️ Pausa a música que está tocando'),

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
          description: `${MusaEmojis.pause} Não estou tocando música no momento! Use ${MusaEmojis.notes} \`/play\` para começar uma sessão musical! ${MusaEmojis.sparkles}`,
          color: MusaColors.warning
        });

        await safeReply(interaction, { embeds: [embed] }, true);
        return;
      }

      // Verificar se há música tocando
      const guildData = musicManager.getGuildMusicData(guildId);
      if (!guildData.isPlaying || guildData.isPaused) {
        const embed = createMusaEmbed({
          title: 'Nada Para Pausar',
          description: guildData.isPaused 
            ? `${MusaEmojis.pause} A música já está pausada! Use \`/resume\` para continuar o ritmo! ${MusaEmojis.notes}`
            : `${MusaEmojis.pause} Não há música tocando no momento! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        });

        await safeReply(interaction, { embeds: [embed] }, true);
        return;
      }

      // Pausar a música
      const success = musicManager.pause(guildId);
      
      if (!success) {
        const embed = createMusaEmbed({
          title: 'Erro ao Pausar',
          description: `${MusaEmojis.warning} ${getRandomPhrase('error')}`,
          color: MusaColors.error
        });

        await safeReply(interaction, { embeds: [embed] });
        return;
      }

      // Criar embed de sucesso
      const currentSong = guildData.currentSong;
      const embed = createMusaEmbed({
        title: 'Música Pausada',
        description: `${MusaEmojis.pause} A melodia foi pausada! O silêncio é apenas um intervalo antes da próxima nota! ${MusaEmojis.notes}`,
        color: MusaColors.warning
      });

      if (currentSong) {
        embed.addFields([
          {
            name: `${MusaEmojis.notes} Música Pausada`,
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

      embed.setFooter({ 
        text: `${MusaEmojis.play} Use /resume para continuar tocando` 
      });

      await safeReply(interaction, { embeds: [embed] });

      logEvent('music_paused_by_command', {
        guildId,
        userId: member.id,
        currentSong: currentSong?.title
      });

    } catch (error) {
      logError('Pause command failed', error as Error, {
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
