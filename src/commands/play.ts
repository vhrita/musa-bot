import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  GuildMember, 
  VoiceChannel 
} from 'discord.js';
import { MusicManager } from '../services/MusicManager';
import { QueuedSong } from '../types/music';
import { 
  createMusaEmbed, 
  safeReply, 
  MusaColors, 
  MusaEmojis, 
  getServiceEmoji,
  formatDuration,
  truncateText,
  getRandomPhrase
} from '../utils/discord';
import { logEvent, logError } from '../utils/logger';
import { botConfig } from '../config';
import { analyzeUrl, detectProvider, detectContentKind } from '../utils/providers';
import { SpotifyPlaylistProvider } from '../services/providers/SpotifyPlaylistProvider';
import { TrackResolver } from '../services/TrackResolver';
import { spawn } from 'child_process';

export default {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('🎵 Adiciona uma música à playlist e começa a tocar!')
    .addStringOption(option =>
      option
        .setName('query')
        .setDescription('Nome da música, artista ou termo de busca')
        .setRequired(true)
        .setMaxLength(200)
    ),

  async execute(interaction: ChatInputCommandInteraction, musicManager: MusicManager): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });

      const query = interaction.options.getString('query', true);
      const member = interaction.member as GuildMember;
      const guildId = interaction.guildId!;

      // Validar pré-condições
      const validationResult = await this.validatePlayRequest(interaction, member, musicManager);
      if (!validationResult.success) {
        await safeReply(interaction, { embeds: [validationResult.embed] }, true);
        return;
      }

      logEvent('play_command_started', {
        guildId,
        userId: member.id,
        query,
        voiceChannel: validationResult.voiceChannel!.name
      });

      // Se for URL, tratar provedores diretamente
      const urlInfo = analyzeUrl(query);
      const provider = detectProvider(query);
      const kind = detectContentKind(query);

      let selectedSong: any | null = null;

      if ((provider === 'youtube' || provider === 'ytm') && kind === 'track') {
        // Canonicalizar para watch URL e pegar metadados via yt-dlp (best-effort)
        const videoId = urlInfo.videoId;
        const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : query;
        selectedSong = await this.fetchYouTubeMeta(watchUrl);
        if (!selectedSong) {
          // fallback mínimo
          selectedSong = { title: watchUrl, url: watchUrl, service: 'youtube' };
        }
      } else if (provider === 'spotify' && kind === 'track') {
        // Pegar metadados do Spotify e resolver para YouTube
        if (!botConfig.spotify?.enabled) {
          throw new Error('Spotify não está habilitado no ambiente.');
        }
        const sp = new SpotifyPlaylistProvider();
        const meta = await sp.getTrack(query);
        if (!meta) {
          throw new Error('Não consegui obter metadados dessa faixa do Spotify.');
        }
        const resolver = new TrackResolver(musicManager.getMultiSourceManager());
        const payload: { title: string; artists: string[]; durationMs?: number } = {
          title: meta.title,
          artists: meta.artists,
        };
        if (typeof meta.durationMs === 'number') payload.durationMs = meta.durationMs;
        const res = await resolver.resolveToYouTube(payload);
        if (!res) {
          throw new Error('Não encontrei uma versão tocável dessa música no YouTube.');
        }
        selectedSong = {
          title: res.title,
          url: res.url,
          service: 'youtube',
          duration: typeof res.duration === 'number' ? res.duration : undefined,
          creator: res.creator || undefined,
          thumbnail: meta.thumbnailUrl || undefined,
        };
      } else {
        // Buscar música via MultiSource
        selectedSong = await this.searchMusic(query, musicManager);
      }
      if (!selectedSong) {
        const embed = createMusaEmbed({
          title: 'Nenhuma Música Encontrada',
          description: `${MusaEmojis.search} Não consegui encontrar "${truncateText(query, 50)}" em nenhuma das minhas fontes musicais! Tente um termo diferente! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        });

        await safeReply(interaction, { embeds: [embed] });
        return;
      }

      // Adicionar à queue e responder
      await this.addSongAndRespond(interaction, musicManager, selectedSong, member, guildId);

    } catch (error) {
      await this.handlePlayError(interaction, error as Error);
    }
  },

  async validatePlayRequest(
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
          description: `${MusaEmojis.microphone} Você precisa estar em um canal de voz para eu tocar música! Entre em um canal e tente novamente! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        })
      };
    }

    // Verificar permissões
    const botPermissions = userVoiceChannel.permissionsFor(interaction.client.user);
    if (!botPermissions?.has(['Connect', 'Speak'])) {
      return {
        success: false,
        embed: createMusaEmbed({
          title: 'Permissões Insuficientes',
          description: `${MusaEmojis.warning} Não tenho permissão para entrar ou falar no canal **${userVoiceChannel.name}**! ${MusaEmojis.notes}`,
          color: MusaColors.error
        })
      };
    }

    // Verificar canal da Musa
    if (botConfig.musaChannelId && interaction.channelId !== botConfig.musaChannelId) {
      return {
        success: false,
        embed: createMusaEmbed({
          title: 'Canal Exclusivo da Musa',
          description: `${MusaEmojis.fairy} Eu só posso tocar música no meu canal especial! Vá para <#${botConfig.musaChannelId}> para usar meus comandos musicais! ${MusaEmojis.sparkles}`,
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

  async searchMusic(query: string, musicManager: MusicManager) {
    const searchResults = await musicManager
      .getMultiSourceManager()
      .search(query, botConfig.services.radio.maxResults);

    return searchResults.length > 0 ? searchResults[0] : null;
  },

  async addSongAndRespond(
    interaction: ChatInputCommandInteraction,
    musicManager: MusicManager,
    selectedSong: any,
    member: GuildMember,
    guildId: string
  ): Promise<void> {
    const queuedSong: QueuedSong = {
      title: selectedSong.title,
      url: selectedSong.url,
      service: selectedSong.service,
      requestedBy: member.displayName,
      addedAt: new Date(),
      isLiveStream: selectedSong.isLiveStream || false,
    };

    // Adicionar propriedades opcionais se existirem
    if (selectedSong.duration !== undefined) {
      queuedSong.duration = selectedSong.duration;
    }
    if (selectedSong.creator !== undefined) {
      queuedSong.creator = selectedSong.creator;
    }
    if (selectedSong.thumbnail !== undefined) {
      queuedSong.thumbnail = selectedSong.thumbnail;
    }

    // Adicionar à queue
    try {
      await musicManager.addToQueue(guildId, queuedSong, member.id);
    } catch (error) {
      const embed = createMusaEmbed({
        title: 'Erro na Playlist',
        description: `${MusaEmojis.warning} ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
        color: MusaColors.error
      });

      await safeReply(interaction, { embeds: [embed] });
      return;
    }

    // Criar e enviar embed de resposta
    const responseEmbed = this.createResponseEmbed(musicManager, selectedSong, member, guildId);
    await safeReply(interaction, { embeds: [responseEmbed] });

    // Log de sucesso
    const guildData = musicManager.getGuildMusicData(guildId);
    const isNowPlaying = guildData.currentSong?.title === selectedSong.title;
    
    logEvent('play_command_completed', {
      guildId,
      userId: member.id,
      title: selectedSong.title,
      service: selectedSong.service,
      isNowPlaying,
      queuePosition: isNowPlaying ? 0 : guildData.queue.length
    });
  },

  createResponseEmbed(musicManager: MusicManager, selectedSong: any, member: GuildMember, guildId: string) {
    const guildData = musicManager.getGuildMusicData(guildId);
    const isNowPlaying = guildData.currentSong?.title === selectedSong.title;

    const embed = createMusaEmbed({
      title: isNowPlaying ? 'Tocando Agora' : 'Adicionada à Playlist',
      description: isNowPlaying 
        ? getRandomPhrase('playing')
        : getRandomPhrase('added'),
      color: isNowPlaying ? MusaColors.nowPlaying : MusaColors.success,
      timestamp: true
    });

    const serviceEmoji = getServiceEmoji(selectedSong.service);
    const title = truncateText(selectedSong.title, 60);
    
    embed.addFields([
      {
        name: `${MusaEmojis.notes} Música`,
        value: `${serviceEmoji} **${title}**`,
        inline: false
      }
    ]);

    if (selectedSong.creator) {
      embed.addFields([
        {
          name: `${MusaEmojis.microphone} Artista`,
          value: truncateText(selectedSong.creator, 40),
          inline: true
        }
      ]);
    }

    if (selectedSong.duration) {
      embed.addFields([
        {
          name: `${MusaEmojis.cd} Duração`,
          value: formatDuration(selectedSong.duration),
          inline: true
        }
      ]);
    }

    if (selectedSong.isLiveStream) {
      embed.addFields([
        {
          name: `${MusaEmojis.live} Status`,
          value: 'Transmissão ao vivo',
          inline: true
        }
      ]);
    }

    if (!isNowPlaying) {
      embed.addFields([
        {
          name: `${MusaEmojis.queue} Posição na Fila`,
          value: `#${guildData.queue.length + 1}`,
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

    if (selectedSong.thumbnail) {
      embed.setThumbnail(selectedSong.thumbnail);
    }

    return embed;
  },

  async handlePlayError(interaction: ChatInputCommandInteraction, error: Error): Promise<void> {
    logError('Play command failed', error, {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      query: interaction.options.getString('query')
    });

    const embed = createMusaEmbed({
      title: 'Erro Musical',
      description: `${MusaEmojis.warning} ${getRandomPhrase('error')}`,
      color: MusaColors.error
    });

    await safeReply(interaction, { embeds: [embed] });
  },

  async fetchYouTubeMeta(videoUrl: string): Promise<any | null> {
    return new Promise((resolve) => {
      let output = '';
      let errorOutput = '';
      const args = [
        '--dump-json',
        '--no-warnings',
        '--skip-download',
        '--no-check-certificate',
        videoUrl,
      ];
      if (botConfig.ytdlpCookies) {
        try {
          const fs = require('fs');
          if (fs.existsSync(botConfig.ytdlpCookies)) {
            args.splice(-1, 0, '--cookies', botConfig.ytdlpCookies);
          }
        } catch { /* ignore */ }
      }
      const p = spawn('yt-dlp', args);
      p.stdout.on('data', (d) => { output += d.toString(); });
      p.stderr.on('data', (d) => { errorOutput += d.toString(); });
      p.on('close', () => {
        try {
          const data = JSON.parse(output.trim().split('\n')[0] || '{}');
          if (!data || !data.title) return resolve({ title: videoUrl, url: videoUrl, service: 'youtube' });
          return resolve({
            title: data.title,
            url: data.webpage_url || videoUrl,
            duration: data.duration || undefined,
            creator: data.uploader || data.channel || undefined,
            thumbnail: data.thumbnail || undefined,
            service: 'youtube',
          });
        } catch {
          return resolve({ title: videoUrl, url: videoUrl, service: 'youtube' });
        }
      });
      p.on('error', () => resolve({ title: videoUrl, url: videoUrl, service: 'youtube' }));
    });
  },
};
