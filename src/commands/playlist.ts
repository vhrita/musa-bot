import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember
} from 'discord.js';
import { MusicManager } from '../services/MusicManager';
import { createMusaEmbed, safeReply, MusaColors, MusaEmojis, truncateText } from '../utils/discord';
import { logEvent, logError } from '../utils/logger';
import { detectProvider, detectContentKind } from '../utils/providers';
import PlayCommand from './play';
import { YouTubePlaylistProvider } from '../services/providers/YouTubePlaylistProvider';
import { QueuedSong } from '../types/music';
import { SpotifyPlaylistProvider } from '../services/providers/SpotifyPlaylistProvider';
import { TrackResolver } from '../services/TrackResolver';
import { botConfig } from '../config';

export default {
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('📥 Adiciona uma playlist inteira à fila')
    .addStringOption(option =>
      option
        .setName('url')
        .setDescription('URL da playlist (YouTube/YouTube Music/Spotify)')
        .setRequired(true)
        .setMaxLength(500)
    )
    .addIntegerOption(option =>
      option
        .setName('limit')
        .setDescription('Quantas faixas carregar (default: 500)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(5000)
    )
    .addIntegerOption(option =>
      option
        .setName('offset')
        .setDescription('Ignorar as primeiras N faixas (default: 0)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(5000)
    )
    .addStringOption(option =>
      option
        .setName('source')
        .setDescription('Forçar provedor')
        .addChoices(
          { name: 'Auto', value: 'auto' },
          { name: 'YouTube', value: 'youtube' },
          { name: 'YouTube Music', value: 'ytm' },
          { name: 'Spotify', value: 'spotify' },
        )
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction, musicManager: MusicManager): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });

      const member = interaction.member as GuildMember;
      const guildId = interaction.guildId!;
      const url = interaction.options.getString('url', true);
      const limitOpt = interaction.options.getInteger('limit');
      const offsetOpt = interaction.options.getInteger('offset');
      const sourceOpt = interaction.options.getString('source') as ('auto'|'youtube'|'ytm'|'spotify'|null);

      // Validar canal de voz (reutilizar validação do /play)
      const validation = await (PlayCommand as any).validatePlayRequest?.(interaction, member, musicManager);
      if (!validation?.success) {
        const embed = validation?.embed || createMusaEmbed({
          title: 'Canal de Voz Necessário',
          description: `${MusaEmojis.microphone} Você precisa estar em um canal de voz para eu tocar música! ${MusaEmojis.notes}`,
          color: MusaColors.warning
        });
        await safeReply(interaction, { embeds: [embed] }, true);
        return;
      }

      // Detectar provedor e tipo de conteúdo
      const forced = sourceOpt && sourceOpt !== 'auto' ? sourceOpt : null;
      const provider = forced || detectProvider(url);
      const kind = detectContentKind(url);

      // Evitar que /playlist receba uma música individual (instruir a usar /play)
      if (kind === 'track') {
        const embed = createMusaEmbed({
          title: 'URL de Música Detectada',
          description: `${MusaEmojis.warning} Parece que essa URL é de uma música individual. Use \`/play\` para tocar apenas esta faixa. Se você queria carregar a playlist completa, copie o link da playlist.`,
          color: MusaColors.warning
        });
        await safeReply(interaction, { embeds: [embed] });
        return;
      }

      const limit = typeof limitOpt === 'number' ? limitOpt : 500;
      const offset = typeof offsetOpt === 'number' ? offsetOpt : 0;

      logEvent('playlist_command_started', {
        guildId,
        userId: member.id,
        provider,
        kind,
        limit,
        offset,
      });

      // Roteamento por provedor (YouTube/YTM implementado na próxima tarefa)
      if (provider === 'youtube' || provider === 'ytm') {
        const providerImpl = new YouTubePlaylistProvider();
        if (!providerImpl.supports(url)) {
          const warn = createMusaEmbed({
            title: 'URL Não é de Playlist',
            description: `${MusaEmojis.warning} Esta URL parece não apontar para uma playlist do YouTube. Verifique o link e tente novamente.`,
            color: MusaColors.warning
          });
          await safeReply(interaction, { embeds: [warn] });
          return;
        }

        const started = Date.now();
        const pageSize = botConfig.music.youtubeBatchSize || 100;
        const batchSize = botConfig.music.youtubeBatchSize || 100;
        const added: QueuedSong[] = [];
        let readCount = 0;
        let lastProgressAt = 0;
        let playlistFull = false;
        let firstFlushed = false;

        await safeReply(interaction, { embeds: [createMusaEmbed({
          title: 'Carregando Playlist (YouTube)',
          description: `${MusaEmojis.search} Buscando faixas...`,
          color: MusaColors.queue
        })] });

        const memberName = member.displayName;
        const items = providerImpl.fetchItems(url, { limit, offset, pageSize });
        let buffer: QueuedSong[] = [];

        // Optional dedupe within this ingestion
        const seen = new Set<string>();
        for await (const item of items) {
          readCount += 1;
          const queued: QueuedSong = {
            title: item.title,
            url: item.youtubeVideoUrl!,
            service: 'youtube',
            requestedBy: memberName,
            addedAt: new Date(),
          };
          if (item.durationMs) queued.duration = Math.floor(item.durationMs / 1000);
          if (item.creator) queued.creator = item.creator;
          if (item.thumbnailUrl) queued.thumbnail = item.thumbnailUrl;

          // Dedupe by URL if enabled
          if (botConfig.music.dedupeOnPlaylist) {
            if (seen.has(queued.url)) {
              continue;
            }
            seen.add(queued.url);
          }
          buffer.push(queued);

          // Immediate first flush: start playback ASAP
          if (!firstFlushed && added.length === 0 && buffer.length > 0) {
            try {
              const first = buffer.splice(0, 1);
              const n1 = await musicManager.addManyToQueue(guildId, first, member.id);
              added.push(...first.slice(0, n1));
              firstFlushed = true;
            } catch (e: any) {
              if (typeof e?.message === 'string' && e.message.includes('A playlist está lotada')) {
                playlistFull = true;
                const nextOffset = offset + readCount;
                const embedFull = createMusaEmbed({
                  title: 'Playlist Cheia',
                  description: `${MusaEmojis.warning} A fila atingiu o limite de ${botConfig.music.maxQueueSize} músicas.\n\n` +
                    `Adicionadas até agora: **${added.length}**.\n` +
                    `Para continuar depois, use /playlist novamente com:\n` +
                    `• url: mesma URL\n` +
                    `• offset: ${nextOffset}\n` +
                    `• limit: (quantas deseja adicionar)`,
                  color: MusaColors.warning
                });
                await safeReply(interaction, { embeds: [embedFull] });
                break;
              }
              throw e;
            }
          }
          if (buffer.length >= batchSize) {
            try {
              const n = await musicManager.addManyToQueue(guildId, buffer, member.id);
              added.push(...buffer.slice(0, n));
              buffer = [];
            } catch (e: any) {
              if (typeof e?.message === 'string' && e.message.includes('A playlist está lotada')) {
                playlistFull = true;
                const nextOffset = offset + readCount;
                const embedFull = createMusaEmbed({
                  title: 'Playlist Cheia',
                  description: `${MusaEmojis.warning} A fila atingiu o limite de ${botConfig.music.maxQueueSize} músicas.\n\n` +
                    `Adicionadas até agora: **${added.length}**.\n` +
                    `Para continuar depois, use /playlist novamente com:\n` +
                    `• url: mesma URL\n` +
                    `• offset: ${nextOffset}\n` +
                    `• limit: (quantas deseja adicionar)`,
                  color: MusaColors.warning
                });
                await safeReply(interaction, { embeds: [embedFull] });
                break;
              }
              throw e;
            }
            const now = Date.now();
            if (now - lastProgressAt > 2000) {
              lastProgressAt = now;
              await safeReply(interaction, { embeds: [createMusaEmbed({
                title: 'Carregando Playlist (YouTube)',
                description: `${MusaEmojis.search} Lidos: ${readCount} • Adicionados: ${added.length}`,
                color: MusaColors.queue
              })] });
            }
          }
          if (playlistFull) break;
        }

        if (!playlistFull && buffer.length > 0) {
          try {
            const n = await musicManager.addManyToQueue(guildId, buffer, member.id);
            added.push(...buffer.slice(0, n));
          } catch (e: any) {
            if (typeof e?.message === 'string' && e.message.includes('A playlist está lotada')) {
              const nextOffset = offset + readCount;
              const embedFull = createMusaEmbed({
                title: 'Playlist Cheia',
                description: `${MusaEmojis.warning} A fila atingiu o limite de ${botConfig.music.maxQueueSize} músicas.\n\n` +
                  `Adicionadas até agora: **${added.length}**.\n` +
                  `Para continuar depois, use /playlist novamente com:\n` +
                  `• url: mesma URL\n` +
                  `• offset: ${nextOffset}\n` +
                  `• limit: (quantas deseja adicionar)`,
                color: MusaColors.warning
              });
              await safeReply(interaction, { embeds: [embedFull] });
              playlistFull = true;
            } else {
              throw e;
            }
          }
        }

        const elapsed = Math.round((Date.now() - started) / 1000);
        const summary = createMusaEmbed({
          title: 'Playlist Carregada',
          description: `${MusaEmojis.queue} Adicionadas ${added.length} faixa${added.length !== 1 ? 's' : ''} à fila (${elapsed}s)`,
          color: MusaColors.success
        });
        const nextOffset = offset + readCount;
        summary.addFields({
          name: 'Continuar',
          value: `Ex.: /playlist url:<mesma URL> offset:${nextOffset} limit:100`,
          inline: false
        });
        if (added.length > 0) {
          const f = added[0];
          const l = added[added.length - 1];
          if (f && l) {
            summary.addFields(
              { name: 'Primeira', value: truncateText(f.title, 60), inline: true },
              { name: 'Última', value: truncateText(l.title, 60), inline: true },
              { name: 'Total Lido', value: String(readCount), inline: true },
            );
          }
        }
        await safeReply(interaction, { embeds: [summary] });
        return;
      }

      if (provider === 'spotify') {
        // Guard: Spotify habilitado?
        if (!interaction.client || !interaction.client.musicManager) {
          const warn = createMusaEmbed({
            title: 'Ambiente Inesperado',
            description: `${MusaEmojis.warning} Não consegui acessar o gerenciador de música. Tente novamente.`,
            color: MusaColors.error
          });
          await safeReply(interaction, { embeds: [warn] });
          return;
        }

        const started = Date.now();
        const pageSize = botConfig.music.spotifyBatchSize || 100;
        const batchSize = botConfig.music.spotifyBatchSize || 50; // resolver é mais custoso
        const added: QueuedSong[] = [];
        let readCount = 0;
        let lastProgressAt = 0;
        let playlistFull = false;

        const providerImpl = new SpotifyPlaylistProvider();
        if (!providerImpl.supports(url)) {
          const warn = createMusaEmbed({
            title: 'URL Não é de Playlist do Spotify',
            description: `${MusaEmojis.warning} Esta URL parece não apontar para uma playlist do Spotify.`,
            color: MusaColors.warning
          });
          await safeReply(interaction, { embeds: [warn] });
          return;
        }

        await safeReply(interaction, { embeds: [createMusaEmbed({
          title: 'Carregando Playlist (Spotify)',
          description: `${MusaEmojis.search} Buscando metadados e mapeando para YouTube...`,
          color: MusaColors.queue
        })] });

        // Para Spotify, resolvemos com poucos resultados para reduzir custo.
        const resolver = new TrackResolver(musicManager.getMultiSourceManager(), { maxResults: 1 });
        const items = providerImpl.fetchItems(url, { limit, offset, pageSize });
        let buffer: QueuedSong[] = [];
        // Control concurrency for resolver
        const concurrency = botConfig.music.spotifyResolveConcurrency || 4;
        const inFlight: Promise<void>[] = [];
        let firstFlushed = false;
        let flushing = false;

        const flushBuffer = async () => {
          if (buffer.length === 0) return;
          if (flushing) return;
          flushing = true;
          try {
            // Immediate first flush: if nothing tocando ainda, mande 1
            if (!firstFlushed && added.length === 0 && buffer.length > 0) {
              const first = buffer.splice(0, 1);
              const n1 = await musicManager.addManyToQueue(guildId, first, member.id);
              added.push(...first.slice(0, n1));
              firstFlushed = true;
            }
            if (buffer.length === 0) return;
            const n = await musicManager.addManyToQueue(guildId, buffer, member.id);
            added.push(...buffer.slice(0, n));
            buffer = [];
          } catch (e: any) {
            if (typeof e?.message === 'string' && e.message.includes('A playlist está lotada')) {
              playlistFull = true;
              buffer = [];
              const nextOffset = offset + readCount;
              const embedFull = createMusaEmbed({
                title: 'Playlist Cheia',
                description: `${MusaEmojis.warning} A fila atingiu o limite de ${botConfig.music.maxQueueSize} músicas.\n\n` +
                  `Adicionadas até agora: **${added.length}**.\n` +
                  `Para continuar depois, use /playlist novamente com:\n` +
                  `• url: mesma URL\n` +
                  `• offset: ${nextOffset}\n` +
                  `• limit: (quantas deseja adicionar)`,
                color: MusaColors.warning
              });
              await safeReply(interaction, { embeds: [embedFull] });
              return;
            }
            throw e;
          } finally {
            flushing = false;
          }
          const now = Date.now();
          if (now - lastProgressAt > 2500) {
            lastProgressAt = now;
            await safeReply(interaction, { embeds: [createMusaEmbed({
              title: 'Carregando Playlist (Spotify)',
              description: `${MusaEmojis.search} Lidos: ${readCount} • Adicionados: ${added.length}`,
              color: MusaColors.queue
            })] });
          }
        };

        // Optional dedupe within this ingestion
        const seen = new Set<string>();
        for await (const item of items) {
          if (playlistFull) break;
          readCount += 1;
          const job = (async () => {
            const payload: { title: string; artists: string[]; durationMs?: number } = {
              title: item.title,
              artists: item.artists || [],
            };
            if (typeof item.durationMs === 'number') payload.durationMs = item.durationMs;
            const res = await resolver.resolveToYouTube(payload);
            if (!res) return;
            const q: QueuedSong = {
              // Use Spotify metadata for display to avoid extra lookups
              title: item.title,
              url: res.url,
              service: 'youtube',
              requestedBy: member.displayName,
              addedAt: new Date(),
            };
            // Prefer Spotify-known metadata when present (no extra cost)
            if (typeof item.durationMs === 'number') q.duration = Math.round(item.durationMs / 1000);
            if (item.artists && item.artists.length > 0) q.creator = item.artists.join(', ');
            if (item.thumbnailUrl) q.thumbnail = item.thumbnailUrl;
            if (botConfig.music.dedupeOnPlaylist) {
              if (seen.has(q.url)) return;
              seen.add(q.url);
            }
            buffer.push(q);
            if (buffer.length >= batchSize) await flushBuffer();
          })();
          inFlight.push(job);
          if (inFlight.length >= concurrency) {
            await inFlight.shift();
          }
        }
        // Drain remaining
        await Promise.all(inFlight);
        if (!playlistFull && buffer.length > 0) await flushBuffer();

        const elapsed = Math.round((Date.now() - started) / 1000);
        const summary = createMusaEmbed({
          title: 'Playlist Carregada',
          description: `${MusaEmojis.queue} Adicionadas ${added.length} faixa${added.length !== 1 ? 's' : ''} à fila (${elapsed}s)`,
          color: MusaColors.success
        });
        const nextOffset = offset + readCount;
        summary.addFields({
          name: 'Continuar',
          value: `Ex.: /playlist url:<mesma URL> offset:${nextOffset} limit:100`,
          inline: false
        });
        await safeReply(interaction, { embeds: [summary] });
        return;
      }

      const embed = createMusaEmbed({
        title: 'URL Não Reconhecida',
        description: `${MusaEmojis.warning} Não consegui reconhecer o provedor desta URL. Verifique se é um link válido de YouTube/YouTube Music/Spotify.\n\nURL: ${truncateText(url, 80)}`,
        color: MusaColors.error
      });
      await safeReply(interaction, { embeds: [embed] });
    } catch (error) {
      logError('Playlist command failed', error as Error, {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        url: interaction.options.getString('url')
      });

      const embed = createMusaEmbed({
        title: 'Erro na Playlist',
        description: `${MusaEmojis.warning} Oops! Algo deu errado ao tentar carregar a playlist.`,
        color: MusaColors.error
      });
      await safeReply(interaction, { embeds: [embed] });
    }
  },
};
