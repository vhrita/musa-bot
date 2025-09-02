import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, VoiceChannel } from 'discord.js';
import { MusicManager } from '../services/MusicManager';
import { QueuedSong } from '../types/music';
import { 
  createMusaEmbed, 
  safeReply, 
  MusaColors, 
  MusaEmojis,
  getServiceEmoji,
  truncateText,
  getRandomPhrase
} from '../utils/discord';
import { logEvent, logError } from '../utils/logger';
import { botConfig } from '../config';

export default {
  data: new SlashCommandBuilder()
    .setName('radio')
    .setDescription('📻 Toca estações de rádio por gênero musical')
    .addStringOption(option =>
      option
        .setName('genre')
        .setDescription('Gênero musical da rádio')
        .setRequired(true)
        .addChoices(
          { name: '🎵 Pop Hits', value: 'pop' },
          { name: '🎸 Rock Clássico', value: 'rock' },
          { name: '🎷 Jazz Suave', value: 'jazz' },
          { name: '🎼 Clássica', value: 'classical' },
          { name: '🔊 Electronic', value: 'electronic' },
          { name: '😌 Chill Out', value: 'chill' },
          { name: '🎧 Lo-Fi Hip Hop', value: 'lofi' }
        )
    ),

  async execute(interaction: ChatInputCommandInteraction, musicManager: MusicManager): Promise<void> {
    try {
      await interaction.deferReply();

      const genre = interaction.options.getString('genre', true);
      const member = interaction.member as GuildMember;
      const guildId = interaction.guildId!;

      // Validações básicas
      const validationResult = await this.validateRadioRequest(interaction, member, musicManager);
      if (!validationResult.success) {
        await safeReply(interaction, { embeds: [validationResult.embed] }, true);
        return;
      }

      logEvent('radio_command_started', {
        guildId,
        userId: member.id,
        genre,
        voiceChannel: validationResult.voiceChannel!.name
      });

      // Buscar estações de rádio
      const radioStations = await musicManager
        .getMultiSourceManager()
        .searchRadio(genre, botConfig.services.radio.maxResults);

      if (radioStations.length === 0) {
        const embed = createMusaEmbed({
          title: 'Gênero Não Encontrado',
          description: `${MusaEmojis.radio} Não consegui encontrar estações de **${genre}** no momento! Tente outro gênero musical! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        });

        embed.addFields([
          {
            name: `${MusaEmojis.search} Gêneros Disponíveis`,
            value: this.getAvailableGenresText(musicManager),
            inline: false
          }
        ]);

        await safeReply(interaction, { embeds: [embed] });
        return;
      }

      // Adicionar todas as estações à queue
      await this.addRadioStationsToQueue(interaction, musicManager, radioStations, member, guildId, genre);

    } catch (error) {
      await this.handleRadioError(interaction, error as Error, interaction.options.getString('genre') || undefined);
    }
  },

  async validateRadioRequest(
    interaction: ChatInputCommandInteraction, 
    member: GuildMember, 
    musicManager: MusicManager
  ): Promise<{ success: boolean; embed?: any; voiceChannel?: VoiceChannel }> {
    // Verificar canal de voz
    const userVoiceChannel = member.voice.channel as VoiceChannel | null;
    if (!userVoiceChannel) {
      return {
        success: false,
        embed: createMusaEmbed({
          title: 'Canal de Voz Necessário',
          description: `${MusaEmojis.radio} Você precisa estar em um canal de voz para eu sintonizar as rádios! Entre em um canal e tente novamente! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        })
      };
    }

    // Verificar canal da Musa
    if (botConfig.musaChannelId && interaction.channelId !== botConfig.musaChannelId) {
      return {
        success: false,
        embed: createMusaEmbed({
          title: 'Canal Exclusivo da Musa',
          description: `${MusaEmojis.fairy} Eu só posso sintonizar rádios no meu canal especial! Vá para <#${botConfig.musaChannelId}> para usar meus comandos! ${MusaEmojis.sparkles}`,
          color: MusaColors.warning
        })
      };
    }

    // Conectar ao canal de voz se necessário
    const guildId = interaction.guildId!;
    if (!musicManager.isConnected(guildId)) {
      const connection = await musicManager.joinVoiceChannel(userVoiceChannel);
      if (!connection) {
        return {
          success: false,
          embed: createMusaEmbed({
            title: 'Erro de Conexão',
            description: `${MusaEmojis.warning} ${getRandomPhrase('error')}`,
            color: MusaColors.error
          })
        };
      }
    }

    return { success: true, voiceChannel: userVoiceChannel };
  },

  async addRadioStationsToQueue(
    interaction: ChatInputCommandInteraction,
    musicManager: MusicManager,
    radioStations: any[],
    member: GuildMember,
    guildId: string,
    genre: string
  ): Promise<void> {
    const addedStations: QueuedSong[] = [];

    // Adicionar todas as estações
    for (const station of radioStations) {
      const queuedStation: QueuedSong = {
        title: station.title,
        url: station.url,
        service: station.service,
        requestedBy: member.displayName,
        addedAt: new Date(),
        isLiveStream: true,
        creator: 'Live Radio'
      };

      try {
        await musicManager.addToQueue(guildId, queuedStation);
        addedStations.push(queuedStation);
      } catch (error) {
        logError('Failed to add radio station to queue', error as Error, {
          station: station.title,
          guildId
        });
      }
    }

    if (addedStations.length === 0) {
      const embed = createMusaEmbed({
        title: 'Erro ao Adicionar Rádios',
        description: `${MusaEmojis.warning} Não consegui adicionar nenhuma estação de rádio à playlist! ${MusaEmojis.notes}`,
        color: MusaColors.error
      });

      await safeReply(interaction, { embeds: [embed] });
      return;
    }

    // Criar embed de confirmação
    const guildData = musicManager.getGuildMusicData(guildId);
    const isNowPlaying = guildData.currentSong && addedStations.some(s => s.title === guildData.currentSong?.title);

    const stationText = addedStations.length > 1 ? 'ões' : '';
    const embed = createMusaEmbed({
      title: isNowPlaying ? 'Rádio Sintonizada' : 'Rádios Adicionadas',
      description: isNowPlaying 
        ? `${MusaEmojis.radio} A frequência está perfeita! Sintonizando ${genre.toUpperCase()}! ${MusaEmojis.notes}`
        : `${MusaEmojis.radio} Adicionei ${addedStations.length} estação${stationText} de **${genre.toUpperCase()}** à playlist! ${MusaEmojis.notes}`,
      color: isNowPlaying ? MusaColors.nowPlaying : MusaColors.success,
      timestamp: true
    });

    // Mostrar estações adicionadas
    let stationsText = '';
    addedStations.slice(0, 5).forEach((station) => {
      stationsText += `${getServiceEmoji(station.service)} **${truncateText(station.title, 40)}** ${MusaEmojis.live}\n`;
    });

    if (addedStations.length > 5) {
      stationsText += `... e mais **${addedStations.length - 5}** estação${addedStations.length - 5 > 1 ? 'ões' : ''}!`;
    }

    embed.addFields([
      {
        name: `${MusaEmojis.radio} Estações de ${genre.toUpperCase()}`,
        value: stationsText,
        inline: false
      }
    ]);

    if (!isNowPlaying && guildData.queue.length > addedStations.length) {
      embed.addFields([
        {
          name: `${MusaEmojis.queue} Posição na Fila`,
          value: `A partir da posição #${guildData.queue.length - addedStations.length + 1}`,
          inline: true
        }
      ]);
    }

    embed.addFields([
      {
        name: `${MusaEmojis.fairy} Solicitada por`,
        value: member.displayName,
        inline: true
      }
    ]);

    embed.setFooter({ 
      text: `${MusaEmojis.live} Transmissões ao vivo • Use /skip para trocar de estação` 
    });

    await safeReply(interaction, { embeds: [embed] });

    logEvent('radio_command_completed', {
      guildId,
      userId: member.id,
      genre,
      stationsAdded: addedStations.length,
      isNowPlaying,
      queuePosition: guildData.queue.length
    });
  },

  getAvailableGenresText(musicManager: MusicManager): string {
    const genres = musicManager.getMultiSourceManager().getAvailableRadioGenres();
    return genres.length > 0 
      ? genres.map(g => `\`${g}\``).join(', ')
      : 'Nenhum gênero disponível no momento';
  },

  async handleRadioError(interaction: ChatInputCommandInteraction, error: Error, genre?: string): Promise<void> {
    logError('Radio command failed', error, {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      genre
    });

    const embed = createMusaEmbed({
      title: 'Erro na Rádio',
      description: `${MusaEmojis.warning} ${getRandomPhrase('error')}`,
      color: MusaColors.error
    });

    await safeReply(interaction, { embeds: [embed] });
  },
};
