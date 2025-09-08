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
    .setName('shuffle')
    .setDescription('🔀 Altera a ordem de reprodução (embaralhar ou original)')
    .addStringOption(option =>
      option
        .setName('mode')
        .setDescription('Modo de ordem de reprodução')
        .addChoices(
          { name: 'Embaralhar', value: 'on' },
          { name: 'Ordem Original', value: 'off' },
        )
        .setRequired(false)
    ),

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
          description: `${MusaEmojis.shuffle} Não estou tocando música no momento! Não há playlist para embaralhar! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        });

        await safeReply(interaction, { embeds: [embed] }, true);
        return;
      }

      // Verificar se há músicas na fila
      const guildData = musicManager.getGuildMusicData(guildId);
      if (guildData.queue.length === 0) {
        const embed = createMusaEmbed({
          title: 'Fila Vazia',
          description: `${MusaEmojis.shuffle} A fila está vazia! Não há músicas para embaralhar! Use \`/play\` para adicionar músicas primeiro! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        });

        await safeReply(interaction, { embeds: [embed] }, true);
        return;
      }

      if (guildData.queue.length === 1) {
        const embed = createMusaEmbed({
          title: 'Apenas Uma Música',
          description: `${MusaEmojis.shuffle} Há apenas uma música na fila! Adicione mais músicas para criar um mix interessante! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        });

        await safeReply(interaction, { embeds: [embed] }, true);
        return;
      }

      // Obter informações antes da mudança
      const queueLengthBefore = guildData.queue.length;
      const firstSongBefore = guildData.queue[0]?.title;

      // Determinar modo
      const mode = (interaction.options.getString('mode') as ('on'|'off'|null)) || 'on';

      // Aplicar ordem solicitada
      const who = member.displayName || interaction.user.username;
      const whoId = member.id;
      if (mode === 'off') {
        musicManager.restoreOriginalOrder(guildId, who, whoId);
      } else {
        musicManager.shuffleQueue(guildId, who, whoId);
      }

      // Obter informações após o shuffle
      const firstSongAfter = guildData.queue[0]?.title;

      // Criar embed de confirmação
      const embed = createMusaEmbed({
        title: mode === 'off' ? 'Ordem Original Restaurada' : 'Playlist Embaralhada',
        description: mode === 'off' ? `${MusaEmojis.queue} Ordem original reaplicada às próximas músicas.` : `${MusaEmojis.shuffle} ${this.getShufflePhrase()}`,
        color: MusaColors.success
      });

      embed.addFields([
        {
          name: `${MusaEmojis.queue} Músicas Embaralhadas`,
          value: `**${queueLengthBefore}** músicas foram reorganizadas!`,
          inline: true
        }
      ]);

      if (firstSongBefore && firstSongAfter && firstSongBefore !== firstSongAfter) {
        embed.addFields([
          {
            name: `${MusaEmojis.skip} Nova Próxima`,
            value: `**${firstSongAfter}**`,
            inline: true
          }
        ]);
      }

      embed.addFields([
        {
          name: `${MusaEmojis.fairy} Embaralhada por`,
          value: member.displayName,
          inline: true
        }
      ]);

      embed.setFooter({ 
        text: `${MusaEmojis.queue} Use /queue para ver a nova ordem` 
      });

      await safeReply(interaction, { embeds: [embed] });

      logEvent('shuffle_command_executed', {
        guildId,
        userId: member.id,
        queueLength: queueLengthBefore,
        firstSongBefore,
        firstSongAfter,
        mode
      });

    } catch (error) {
      logError('Shuffle command failed', error as Error, {
        guildId: interaction.guildId,
        userId: interaction.user.id
      });

      const embed = createMusaEmbed({
        title: 'Erro no Shuffle',
        description: `${MusaEmojis.warning} ${getRandomPhrase('error')}`,
        color: MusaColors.error
      });

      await safeReply(interaction, { embeds: [embed] });
    }
  },

  getShufflePhrase(): string {
    const phrases = [
      'As cartas foram embaralhadas! A próxima música será uma surpresa musical! 🎭',
      'Misturei as melodias como um DJ experiente! Vamos ver que ritmo sai! 🎧',
      'Criei uma nova sequência harmônica! A playlist ganhou vida própria! ✨',
      'Reorganizei as notas como uma partitura mágica! Prepare-se para o inesperado! 🎼',
      'Embaralhei as frequências! Agora temos uma sinfonia do acaso! 🎵'
    ];

    const randomIndex = Math.floor(Math.random() * phrases.length);
    return phrases[randomIndex] ?? 'As músicas foram embaralhadas!';
  },
};
