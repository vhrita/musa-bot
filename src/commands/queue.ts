import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { MusicManager } from '../services/MusicManager';
import { 
  createMusaEmbed, 
  safeReply, 
  MusaColors, 
  MusaEmojis,
  getServiceEmoji,
  truncateText,
  formatDuration
} from '../utils/discord';
import { logEvent, logError } from '../utils/logger';

export default {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('📜 Mostra a playlist atual com todas as músicas'),

  async execute(interaction: ChatInputCommandInteraction, musicManager: MusicManager): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
      const guildId = interaction.guildId!;
      const guildData = musicManager.getGuildMusicData(guildId);

      // Verificar se há conteúdo para mostrar
      if (!guildData.currentSong && guildData.queue.length === 0) {
        await this.sendEmptyQueueMessage(interaction);
        return;
      }

      // Criar e enviar embed principal
      const embed = await this.createQueueEmbed(guildData, musicManager, guildId);
      await safeReply(interaction, { embeds: [embed] }, true);

      // Log do evento
      logEvent('queue_command_executed', {
        guildId,
        userId: interaction.user.id,
        currentSong: guildData.currentSong?.title,
        queueLength: guildData.queue.length,
        totalDuration: this.calculateTotalDuration([
          ...(guildData.currentSong ? [guildData.currentSong] : []), 
          ...guildData.queue
        ])
      });

    } catch (error) {
      await this.handleQueueError(interaction, error as Error);
    }
  },

  async sendEmptyQueueMessage(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = createMusaEmbed({
      title: 'Playlist Vazia',
      description: `${MusaEmojis.queue} A playlist está vazia como um palco antes do show! Use \`/play\` para adicionar música e começar a festa! ${MusaEmojis.sparkles}`,
      color: MusaColors.warning
    });

    embed.setFooter({ 
      text: `${MusaEmojis.play} Use /play <música> para começar` 
    });

    await safeReply(interaction, { embeds: [embed] }, true);
  },

  async createQueueEmbed(guildData: any, musicManager: MusicManager, guildId: string) {
    const embed = createMusaEmbed({
      title: 'Playlist Musical',
      description: `${MusaEmojis.notes} Aqui está nossa sinfonia atual! ${guildData.queue.length} música${guildData.queue.length !== 1 ? 's' : ''} esperando para tocar! ${MusaEmojis.sparkles}`,
      color: MusaColors.queue,
      timestamp: true
    });

    // Adicionar seção "Tocando Agora"
    if (guildData.currentSong) {
      this.addNowPlayingSection(embed, guildData);
    }

    // Adicionar seção "Próximas Músicas"
    if (guildData.queue.length > 0) {
      this.addUpcomingSection(embed, guildData.queue);
    }

    // Adicionar informações do rodapé
    this.addFooterInfo(embed, guildData, musicManager, guildId);

    return embed;
  },

  addNowPlayingSection(embed: any, guildData: any): void {
    const currentSong = guildData.currentSong;
    
    // Determinar status e ícone
    let statusIcon: string;
    let statusText: string;
    
    if (guildData.isPlaying) {
      statusIcon = MusaEmojis.play;
      statusText = 'Tocando';
    } else if (guildData.isPaused) {
      statusIcon = MusaEmojis.pause;
      statusText = 'Pausada';
    } else {
      statusIcon = MusaEmojis.stop;
      statusText = 'Parada';
    }

    let nowPlayingValue = `${getServiceEmoji(currentSong.service)} **${truncateText(currentSong.title, 50)}**`;
    
    if (currentSong.creator) {
      nowPlayingValue += `\n${MusaEmojis.microphone} ${truncateText(currentSong.creator, 40)}`;
    }

    if (currentSong.duration) {
      nowPlayingValue += ` • ${formatDuration(currentSong.duration)}`;
    }

    if (currentSong.isLiveStream) {
      nowPlayingValue += ` ${MusaEmojis.live}`;
    }

    nowPlayingValue += `\n${statusIcon} **${statusText}** • Solicitada por ${currentSong.requestedBy}`;

    embed.addFields([
      {
        name: `${MusaEmojis.notes} Tocando Agora`,
        value: nowPlayingValue,
        inline: false
      }
    ]);
  },

  addUpcomingSection(embed: any, queue: any[]): void {
    const maxSongsToShow = 10;
    const songsToShow = queue.slice(0, maxSongsToShow);
    
    let queueText = '';
    songsToShow.forEach((song, index) => {
      const songLine = this.formatQueueSong(song, index + 1);
      queueText += songLine + '\n\n';
    });

    // Adicionar indicador se há mais músicas
    if (queue.length > maxSongsToShow) {
      queueText += `... e mais **${queue.length - maxSongsToShow}** música${queue.length - maxSongsToShow !== 1 ? 's' : ''} na fila!`;
    }

    embed.addFields([
      {
        name: `${MusaEmojis.queue} Próximas Músicas (${queue.length})`,
        value: queueText || 'Nenhuma música na fila',
        inline: false
      }
    ]);
  },

  formatQueueSong(song: any, position: number): string {
    let songLine = `**${position}.** ${getServiceEmoji(song.service)} ${truncateText(song.title, 35)}`;
    
    if (song.creator) {
      songLine += ` • ${truncateText(song.creator, 25)}`;
    }

    if (song.duration) {
      songLine += ` • ${formatDuration(song.duration)}`;
    }

    if (song.isLiveStream) {
      songLine += ` ${MusaEmojis.live}`;
    }

    songLine += `\n   ${MusaEmojis.fairy} ${song.requestedBy}`;
    
    return songLine;
  },

  addFooterInfo(embed: any, guildData: any, musicManager: MusicManager, guildId: string): void {
    const totalDuration = this.calculateTotalDuration([...(guildData.currentSong ? [guildData.currentSong] : []), ...guildData.queue]);
    let footerText = '';

    if (totalDuration > 0) {
      footerText += `Duração total: ${formatDuration(totalDuration)}`;
    }

    if (guildData.loopMode !== 'off') {
      const loopText = guildData.loopMode === 'song' ? 'Repetindo música atual' : 'Repetindo playlist';
      footerText += footerText ? ` • ${loopText}` : loopText;
    }

    if (!musicManager.isConnected(guildId)) {
      footerText += footerText ? ' • Desconectada' : 'Desconectada';
    }

    if (footerText) {
      embed.setFooter({ text: `${MusaEmojis.cd} ${footerText}` });
    }
  },

  async handleQueueError(interaction: ChatInputCommandInteraction, error: Error): Promise<void> {
    logError('Queue command failed', error, {
      guildId: interaction.guildId,
      userId: interaction.user.id
    });

    const embed = createMusaEmbed({
      title: 'Erro na Playlist',
      description: `${MusaEmojis.warning} Ops! Houve uma dissonância ao mostrar a playlist! ${MusaEmojis.notes}`,
      color: MusaColors.error
    });

    await safeReply(interaction, { embeds: [embed] });
  },

  calculateTotalDuration(songs: Array<{ duration?: number }>): number {
    return songs.reduce((total, song) => {
      return total + (song.duration || 0);
    }, 0);
  },
};
