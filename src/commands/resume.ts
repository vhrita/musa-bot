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
    .setName('resume')
    .setDescription('▶️ Retoma a música pausada'),

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
          title: 'Não Estou Conectada',
          description: `${MusaEmojis.play} Não estou conectada a nenhum canal de voz! Use ${MusaEmojis.notes} \`/play\` para começar uma nova sessão musical! ${MusaEmojis.sparkles}`,
          color: MusaColors.warning
        });

        await safeReply(interaction, { embeds: [embed] }, true);
        return;
      }

      // Verificar se há música pausada
      const guildData = musicManager.getGuildMusicData(guildId);
      if (!guildData.isPaused) {
        const embed = createMusaEmbed({
          title: 'Nada Para Retomar',
          description: guildData.isPlaying 
            ? `${MusaEmojis.play} A música já está tocando! O ritmo está fluindo perfeitamente! ${MusaEmojis.notes}`
            : `${MusaEmojis.play} Não há música pausada para retomar! Use \`/play\` para começar! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        });

        await safeReply(interaction, { embeds: [embed] }, true);
        return;
      }

      // Retomar a música
      const success = musicManager.resume(guildId);
      
      if (!success) {
        const embed = createMusaEmbed({
          title: 'Erro ao Retomar',
          description: `${MusaEmojis.warning} ${getRandomPhrase('error')}`,
          color: MusaColors.error
        });

        await safeReply(interaction, { embeds: [embed] });
        return;
      }

      // Criar embed de sucesso
      const currentSong = guildData.currentSong;
      const embed = createMusaEmbed({
        title: 'Música Retomada',
        description: `${MusaEmojis.play} ${getRandomPhrase('playing')}`,
        color: MusaColors.success
      });

      if (currentSong) {
        embed.addFields([
          {
            name: `${MusaEmojis.notes} Tocando Agora`,
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

        if (guildData.queue.length > 0) {
          embed.addFields([
            {
              name: `${MusaEmojis.queue} Próximas`,
              value: `${guildData.queue.length} música${guildData.queue.length > 1 ? 's' : ''} na fila`,
              inline: true
            }
          ]);
        }
      }

      embed.setFooter({ 
        text: `${MusaEmojis.pause} Use /pause para pausar novamente` 
      });

      await safeReply(interaction, { embeds: [embed] });

      logEvent('music_resumed_by_command', {
        guildId,
        userId: member.id,
        currentSong: currentSong?.title,
        queueLength: guildData.queue.length
      });

    } catch (error) {
      logError('Resume command failed', error as Error, {
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
