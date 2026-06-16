/**
 * /radio — Comando de rádio da Musa com Radio Browser API.
 *
 * Comportamento (alinhado ao docs/MELHORIAS.md):
 *  - Aceita um campo de texto livre `station`: preset de gênero OU nome de estação.
 *  - Se bater um preset curado (pop, rock, jazz, …) → busca a estação mais votada por tag.
 *  - Se não bater → busca por nome na Radio Browser API.
 *  - Toca APENAS UMA estação, IMEDIATAMENTE (não enfileira):
 *      a música em reprodução vai pra "já tocadas"; a fila de próximas é preservada.
 *  - Integração com P2 via MusicManager.playRadioNow().
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  VoiceChannel,
  AutocompleteInteraction,
} from 'discord.js';
import { MusicManager } from '../services/MusicManager';
import { QueuedSong } from '../types/music';
import { createMusaEmbed, safeReply, MusaColors, MusaEmojis, getRandomPhrase } from '../utils/discord';
import { logEvent, logError } from '../utils/logger';
import { botConfig } from '../config';
import { searchByName, searchByTag, reportStationClick } from '../services/RadioBrowserService';

// ---------------------------------------------------------------------------
// Presets curados — espelhados do RadioService para o autocomplete do Discord
// ---------------------------------------------------------------------------
const GENRE_PRESETS: Record<string, { label: string; tag: string }> = {
  pop: { label: '🎵 Pop', tag: 'pop' },
  rock: { label: '🎸 Rock', tag: 'rock' },
  jazz: { label: '🎷 Jazz', tag: 'jazz' },
  classical: { label: '🎼 Classical', tag: 'classical' },
  electronic: { label: '🔊 Electronic', tag: 'electronic' },
  chill: { label: '😌 Chill Out', tag: 'chillout' },
  lofi: { label: '🎧 Lo-Fi', tag: 'lofi' },
  metal: { label: '🤘 Metal', tag: 'metal' },
  hiphop: { label: '🎤 Hip-Hop', tag: 'hip hop' },
  country: { label: '🤠 Country', tag: 'country' },
  blues: { label: '🎸 Blues', tag: 'blues' },
  reggae: { label: '🌴 Reggae', tag: 'reggae' },
  latin: { label: '🌎 Latin', tag: 'latin' },
  rnb: { label: '💜 R&B / Soul', tag: 'rnb' },
  ambient: { label: '🌊 Ambient', tag: 'ambient' },
  news: { label: '📰 News / Talk', tag: 'news' },
};

export default {
  data: new SlashCommandBuilder()
    .setName('radio')
    .setDescription('📻 Sintoniza uma estação de rádio ao vivo')
    .addStringOption((option) =>
      option
        .setName('station')
        .setDescription(
          'Gênero (pop, rock, jazz, lofi…) ou nome de uma estação (ex: "Jazz 24/7", "BBC Radio 1")',
        )
        .setRequired(true)
        .setAutocomplete(true),
    ),

  /** Autocomplete: mostra presets curados para queries curtas, busca na API para textos maiores. */
  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused().toLowerCase().trim();

    if (!focused) {
      // Mostra todos os presets
      const choices = Object.entries(GENRE_PRESETS).map(([key, v]) => ({
        name: v.label,
        value: key,
      }));
      await interaction.respond(choices.slice(0, 25));
      return;
    }

    // Filtra presets que batem a query
    const matchedPresets = Object.entries(GENRE_PRESETS)
      .filter(([key, v]) => key.includes(focused) || v.label.toLowerCase().includes(focused))
      .map(([key, v]) => ({ name: v.label, value: key }));

    if (matchedPresets.length >= 3) {
      await interaction.respond(matchedPresets.slice(0, 25));
      return;
    }

    // Completa com busca por nome na API (top 10 → filtra pra 25 total)
    try {
      const apiResults = await searchByName(focused, 10);
      const apiChoices = apiResults.slice(0, 25 - matchedPresets.length).map((s) => ({
        name: `${s.name}${s.country ? ` (${s.countrycode})` : ''}`.substring(0, 100),
        value: s.name,
      }));

      await interaction.respond([...matchedPresets, ...apiChoices].slice(0, 25));
    } catch {
      // Se a API falhar no autocomplete, retorna só os presets filtrados
      await interaction.respond(matchedPresets.slice(0, 25));
    }
  },

  async execute(interaction: ChatInputCommandInteraction, musicManager: MusicManager): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });

      const stationQuery = interaction.options.getString('station', true).trim();
      const member = interaction.member as GuildMember;
      const guildId = interaction.guildId!;

      // Validações básicas de canal de voz e canal da Musa
      const validationResult = await validateRadioRequest(interaction, member, musicManager);
      if (!validationResult.success) {
        await safeReply(interaction, { embeds: [validationResult.embed!] });
        return;
      }

      logEvent('radio_command_started', {
        guildId,
        userId: member.id,
        stationQuery,
        voiceChannel: validationResult.voiceChannel!.name,
      });

      // Busca a estação
      const station = await resolveStation(stationQuery);

      if (!station) {
        const presetList = Object.entries(GENRE_PRESETS)
          .map(([k, v]) => `\`${k}\` ${v.label}`)
          .join('\n');

        const embed = createMusaEmbed({
          title: 'Estação Não Encontrada',
          description:
            `${MusaEmojis.radio} Não encontrei nenhuma estação para **${stationQuery}**! ` +
            `Tente um dos gêneros abaixo ou o nome de uma rádio conhecida. ${MusaEmojis.notes}`,
          color: MusaColors.warning,
        });

        embed.addFields([
          {
            name: `${MusaEmojis.search} Gêneros Disponíveis`,
            value: presetList,
            inline: false,
          },
        ]);

        await safeReply(interaction, { embeds: [embed] });
        return;
      }

      // Monta QueuedSong (exactOptionalPropertyTypes: omit undefined fields)
      const queuedStation: QueuedSong = {
        title: station.title,
        url: station.url,
        service: 'radio',
        requestedBy: member.displayName,
        addedAt: new Date(),
        isLiveStream: true,
        creator: station.creator,
        ...(station.thumbnail ? { thumbnail: station.thumbnail } : {}),
      };

      // P2: toca imediatamente sobrescrevendo a posição atual
      const guildData = musicManager.getGuildMusicData(guildId);
      const previousTitle = guildData.currentSong?.title ?? null;

      await musicManager.playRadioNow(guildId, queuedStation);

      // Reporta click pra Radio Browser (async, não bloqueia resposta)
      if (station.stationuuid) {
        void reportStationClick(station.stationuuid);
      }

      // Resposta de confirmação
      const wasPlaying = previousTitle !== null;
      const embed = createMusaEmbed({
        title: '📻 Rádio Sintonizada!',
        description: `${MusaEmojis.radio} Sintonizando **${station.name}** agora! ${MusaEmojis.live}`,
        color: MusaColors.nowPlaying,
        timestamp: true,
      });

      embed.addFields([
        {
          name: `${MusaEmojis.radio} Estação`,
          value: station.title,
          inline: false,
        },
      ]);

      if (station.codec) {
        embed.addFields([
          {
            name: '🎛️ Codec / Bitrate',
            value: `${station.codec.toUpperCase()}${station.bitrate ? ` • ${station.bitrate}kbps` : ''}`,
            inline: true,
          },
        ]);
      }

      if (wasPlaying) {
        embed.addFields([
          {
            name: `${MusaEmojis.previous} Música Anterior`,
            value: `\`${previousTitle}\` movida para "já tocadas"`,
            inline: false,
          },
        ]);
      }

      if (guildData.queue.length > 0) {
        embed.addFields([
          {
            name: `${MusaEmojis.queue} Fila Preservada`,
            value: `${guildData.queue.length} música${guildData.queue.length !== 1 ? 's' : ''} aguardando`,
            inline: true,
          },
        ]);
      }

      embed.addFields([
        {
          name: `${MusaEmojis.fairy} Solicitada por`,
          value: member.displayName,
          inline: true,
        },
      ]);

      embed.setFooter({
        text: `${MusaEmojis.live} Transmissão ao vivo • Use /skip para parar o rádio e voltar à fila`,
      });

      await safeReply(interaction, { embeds: [embed] });

      logEvent('radio_command_completed', {
        guildId,
        userId: member.id,
        stationQuery,
        stationTitle: station.title,
        wasPlaying,
        queuePreserved: guildData.queue.length,
      });
    } catch (error) {
      logError('Radio command failed', error as Error, {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        stationQuery: interaction.options.getString('station') ?? undefined,
      });

      const embed = createMusaEmbed({
        title: 'Erro na Rádio',
        description: `${MusaEmojis.warning} ${getRandomPhrase('error')}`,
        color: MusaColors.error,
      });

      await safeReply(interaction, { embeds: [embed] });
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function validateRadioRequest(
  interaction: ChatInputCommandInteraction,
  member: GuildMember,
  musicManager: MusicManager,
): Promise<{ success: boolean; embed?: any; voiceChannel?: VoiceChannel }> {
  const userVoiceChannel = member.voice.channel as VoiceChannel | null;
  if (!userVoiceChannel) {
    return {
      success: false,
      embed: createMusaEmbed({
        title: 'Canal de Voz Necessário',
        description: `${MusaEmojis.radio} Você precisa estar em um canal de voz para sintonizar uma rádio! ${MusaEmojis.notes}`,
        color: MusaColors.warning,
      }),
    };
  }

  if (botConfig.musaChannelId && interaction.channelId !== botConfig.musaChannelId) {
    return {
      success: false,
      embed: createMusaEmbed({
        title: 'Canal Exclusivo da Musa',
        description: `${MusaEmojis.fairy} Use meus comandos no canal <#${botConfig.musaChannelId}>! ${MusaEmojis.sparkles}`,
        color: MusaColors.warning,
      }),
    };
  }

  const guildId = interaction.guildId!;
  if (!musicManager.isConnected(guildId)) {
    const connection = await musicManager.joinVoiceChannel(userVoiceChannel);
    if (!connection) {
      return {
        success: false,
        embed: createMusaEmbed({
          title: 'Erro de Conexão',
          description: `${MusaEmojis.warning} ${getRandomPhrase('error')}`,
          color: MusaColors.error,
        }),
      };
    }
  }

  return { success: true, voiceChannel: userVoiceChannel };
}

interface ResolvedStation {
  name: string;
  title: string;
  url: string;
  creator: string;
  thumbnail?: string;
  stationuuid?: string;
  codec?: string;
  bitrate?: number;
}

/**
 * Resolve uma query para uma estação de rádio concreta.
 * 1. Se a query bate um preset → busca por tag, pega a mais votada.
 * 2. Senão → busca por nome, pega a mais popular por clickcount.
 */
async function resolveStation(query: string): Promise<ResolvedStation | null> {
  const q = query.toLowerCase().trim();
  const preset = GENRE_PRESETS[q];

  let stations;
  if (preset) {
    stations = await searchByTag(preset.tag, 5);
  } else {
    stations = await searchByName(query, 10);
  }

  const station = stations[0];
  if (!station) return null;

  const url = station.url_resolved || station.url;
  const codecInfo = station.codec ? ` [${station.codec.toUpperCase()}]` : '';
  const bitrateInfo = station.bitrate > 0 ? ` ${station.bitrate}kbps` : '';

  const resolved: ResolvedStation = {
    name: station.name,
    title: `📻 ${station.name}${codecInfo}${bitrateInfo}`,
    url,
    creator: station.country ? `${station.countrycode} • Radio Browser` : 'Radio Browser',
    stationuuid: station.stationuuid,
    ...(station.codec ? { codec: station.codec } : {}),
    ...(station.bitrate > 0 ? { bitrate: station.bitrate } : {}),
    ...(station.favicon ? { thumbnail: station.favicon } : {}),
  };
  return resolved;
}
