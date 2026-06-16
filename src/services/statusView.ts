/**
 * Pure, synchronous render function for the Musa status embed.
 *
 * Contract:
 *  - Zero `await`, zero `fetch`, zero `fs`.  Everything needed must already
 *    live in the StatusSnapshot (pre-resolved by the caller).
 *  - Same input → same output, always.  Testable with snapshot tests.
 *  - Returns { embeds, components } ready to pass to msg.edit / channel.send.
 *
 * Migrating to Components V2 in the future is a single-function change here;
 * StatusRenderer, MusicManager and interactionCreate don't need to change.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
  createMusaEmbed,
  getRandomPhrase,
  MusaColors,
  MusaEmojis,
  truncateText,
  formatDuration,
} from '../utils/discord';
import { QueuedSong } from '../types/music';

// ─── Snapshot type ────────────────────────────────────────────────────────────

export interface StatusSnapshot {
  version: number;
  currentSong: QueuedSong | null;
  /** Copied slice of the queue — NOT the live array ref. */
  queue: QueuedSong[];
  isPaused: boolean;
  startedAt?: number | undefined; // epoch ms
  /** Copied slice of recently played (up to 6). */
  recent: QueuedSong[];
  playedCount: number;
  lastShuffle?: { by: string; byId?: string | undefined; at: number } | undefined;
  lastAdded?: { by: string; byId?: string | undefined; at: number } | undefined;
  voiceChannelName?: string | undefined;
  /** Pre-resolved avatar URL for the footer icon (from cache). */
  footerAvatarUrl?: string | undefined;
}

// ─── Button custom-IDs ───────────────────────────────────────────────────────

export const BUTTON_IDS = {
  playpause: 'musa:playpause',
  skip: 'musa:skip',
  shuffle: 'musa:shuffle',
  stop: 'musa:stop',
} as const;

// ─── Render ───────────────────────────────────────────────────────────────────

export interface RenderOutput {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

/**
 * Build the status embed + button row from an immutable snapshot.
 * No I/O — synchronous.
 */
export function renderStatus(s: StatusSnapshot): RenderOutput {
  const embed = buildEmbed(s);
  const components = buildButtons(s);
  return { embeds: [embed], components };
}

// ─── Embed builder ────────────────────────────────────────────────────────────

function buildEmbed(s: StatusSnapshot): EmbedBuilder {
  const fields: { name: string; value: string; inline?: boolean }[] = [];

  let title: string;
  let color: string;
  if (!s.currentSong) {
    title = 'Silêncio Encantado';
    color = MusaColors.warning as string;
  } else if (s.isPaused) {
    title = `${MusaEmojis.pause} Pausada`;
    color = MusaColors.queue as string; // visually distinct from playing
  } else {
    title = 'Tocando Agora';
    color = MusaColors.nowPlaying as string;
  }

  const description = s.currentSong
    ? s.isPaused
      ? `${MusaEmojis.pause} Em pausa...`
      : getRandomPhrase('playing') || `${MusaEmojis.notes} Tocando com carinho!`
    : getRandomPhrase('idle') || `${MusaEmojis.mute || '🔇'} Em silêncio...`;

  const base: Parameters<typeof createMusaEmbed>[0] = {
    title,
    description,
    color: color as any,
    fields,
    timestamp: true,
  };

  // Now playing block
  if (s.currentSong) {
    const song = s.currentSong;
    fields.push({
      name: `${MusaEmojis.notes} Música`,
      value: truncateText(song.title, 70),
      inline: false,
    });
    if (song.creator) {
      fields.push({
        name: `${MusaEmojis.microphone} Artista`,
        value: truncateText(song.creator, 40),
        inline: true,
      });
    }
    if (song.requestedBy) {
      fields.push({
        name: `${MusaEmojis.fairy} Adicionada por`,
        value: truncateText(song.requestedBy, 30),
        inline: true,
      });
    }
    if (s.voiceChannelName) {
      fields.push({
        name: `${MusaEmojis.headphones} Canal de Voz`,
        value: s.voiceChannelName,
        inline: true,
      });
    }
    if (typeof song.duration === 'number' && song.duration > 0) {
      fields.push({
        name: `${MusaEmojis.cd} Duração`,
        value: formatDuration(song.duration),
        inline: true,
      });
    }

    // Thumbnail is already resolved in the snapshot
    const thumb = song.thumbnail;
    if (thumb) {
      base.thumbnail = thumb;
    }
    // If no thumbnail, the embed simply has none (no fs.existsSync needed here)
  }

  // Queue block
  const upcoming = s.queue.slice(0, 6);
  const queueLines = upcoming.map((q, idx) => {
    const artist = q.creator ? ` — ${truncateText(q.creator, 30)}` : '';
    const by = q.requestedBy ? ` • por ${truncateText(q.requestedBy, 20)}` : '';
    const live = q.isLiveStream ? ` ${MusaEmojis.live}` : '';
    return `${idx + 1}. ${truncateText(q.title, 60)}${artist}${by}${live}`;
  });
  fields.push({
    name: `${MusaEmojis.queue} Próximas Músicas (${s.queue.length})`,
    value:
      queueLines.length > 0
        ? queueLines.join('\n')
        : `${MusaEmojis.search} A fila está vazia — use /play para adicionar músicas!`,
    inline: false,
  });

  // Last shuffle
  if (s.lastShuffle?.at && s.lastShuffle.by) {
    const d = new Date(s.lastShuffle.at);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    fields.push({
      name: `${MusaEmojis.shuffle} Último Shuffle`,
      value: `por ${s.lastShuffle.by} • ${hh}:${mm}`,
      inline: true,
    });
  }

  // Footer (last added)
  if (s.lastAdded?.by && s.lastAdded.at) {
    const d = new Date(s.lastAdded.at);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    base.footer = `Última música adicionada por ${s.lastAdded.by} • ${hh}:${mm}`;
    if (s.footerAvatarUrl) {
      base.footerIconUrl = s.footerAvatarUrl;
    }
  }

  const embed = createMusaEmbed(base);

  // Recently played
  const recent = s.recent.slice(0, 6);
  if (recent.length > 0) {
    const linesRecent = recent.map((q, idx) => {
      const artist = q.creator ? ` — ${truncateText(q.creator, 30)}` : '';
      const by = q.requestedBy ? ` • por ${truncateText(q.requestedBy, 20)}` : '';
      return `${idx + 1}. ${truncateText(q.title, 60)}${artist}${by}`;
    });
    const count = s.playedCount > 0 ? s.playedCount : recent.length;
    embed.addFields({
      name: `${MusaEmojis.cd} Já Tocaram (${count})`,
      value: linesRecent.join('\n'),
      inline: false,
    });
  }

  return embed;
}

// ─── Button row builder ───────────────────────────────────────────────────────

function buildButtons(s: StatusSnapshot): ActionRowBuilder<ButtonBuilder>[] {
  // MVP: ⏯ pause/resume · ⏭ skip · 🔀 shuffle · ⏹ stop
  // Previous (⏮) and pagination are PR4.

  const hasActive = s.currentSong !== null;
  const canSkip = hasActive && s.queue.length > 0;

  const playpause = new ButtonBuilder()
    .setCustomId(BUTTON_IDS.playpause)
    .setLabel(s.isPaused ? '▶️' : '⏸️')
    .setStyle(s.isPaused ? ButtonStyle.Success : ButtonStyle.Primary)
    .setDisabled(!hasActive);

  const skip = new ButtonBuilder()
    .setCustomId(BUTTON_IDS.skip)
    .setLabel('⏭️')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!canSkip);

  const shuffle = new ButtonBuilder()
    .setCustomId(BUTTON_IDS.shuffle)
    .setLabel('🔀')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(s.queue.length < 2);

  const stop = new ButtonBuilder()
    .setCustomId(BUTTON_IDS.stop)
    .setLabel('⏹️')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(!hasActive);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(playpause, skip, shuffle, stop);

  return [row];
}
