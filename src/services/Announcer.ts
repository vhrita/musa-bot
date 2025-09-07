import { Client, TextChannel, EmbedBuilder } from 'discord.js';
import path from 'path';
import fs from 'fs';
import { botConfig } from '../config';
import { logEvent, logError } from '../utils/logger';
import { createMusaEmbed, getRandomPhrase, MusaColors, MusaEmojis, truncateText, formatDuration } from '../utils/discord';
import { QueuedSong } from '../types/music';

class AnnouncerImpl {
  private client: Client | null = null;
  private lastNowPlayingMessageIdByGuild = new Map<string, string>();

  setClient(client: Client) {
    this.client = client;
  }

  async updateGuildStatus(guildId: string, data: {
    currentSong: QueuedSong | null;
    queue: QueuedSong[];
    voiceChannelName?: string;
    voiceChannelId?: string;
    startedAt?: number; // epoch ms
    recent?: QueuedSong[];
    lastShuffle?: { by: string; at: number };
  }) {
    try {
      if (!this.client) return;
      const channelId = botConfig.musaChannelId;
      if (!channelId) return;

      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return;
      const textChannel = channel as TextChannel;

      // Resolve voice channel name if only id was provided
      if (!data.voiceChannelName && data.voiceChannelId) {
        try {
          const vc = await this.client.channels.fetch(data.voiceChannelId);
          if (vc && 'name' in vc) data.voiceChannelName = (vc as any).name as string;
        } catch { /* ignore */ }
      }

      const embed = await this.buildStatusEmbed(data);
      const files = (embed as any).__files as Array<{ attachment: string; name?: string }> | undefined;
      delete (embed as any).__files;

      const lastId = this.lastNowPlayingMessageIdByGuild.get(guildId);
      if (lastId) {
        try {
          const msg = await textChannel.messages.fetch(lastId);
          if (files) {
            await msg.edit({ embeds: [embed], files });
          } else {
            await msg.edit({ embeds: [embed] });
          }
          logEvent('status_message_edited', { guildId, messageId: lastId });
          return;
        } catch {
          // fallthrough to send
        }
      }

      // Try to reuse an existing bot message in this channel (after restarts), paginating up to ~1000 msgs
      try {
        const botId = this.client.user?.id;
        let before: string | undefined = undefined;
        for (let i = 0; i < 10; i++) {
          const opts: any = { limit: 100 };
          if (before) opts.before = before;
          const page: any = await textChannel.messages.fetch(opts);
          const list: any[] = page && typeof page.values === 'function' ? Array.from(page.values()) : Array.isArray(page) ? page : page ? [page] : [];
          const existing = list.find((m) => m?.author?.id === botId);
          if (existing) {
            if (files) await existing.edit({ embeds: [embed], files }); else await existing.edit({ embeds: [embed] });
            this.lastNowPlayingMessageIdByGuild.set(guildId, existing.id);
            logEvent('status_message_reused', { guildId, messageId: existing.id, page: i });
            return;
          }
          const oldest = list[list.length - 1];
          if (!oldest?.id) break;
          before = oldest.id as string;
        }
      } catch { /* ignore */ }

      const sent = await textChannel.send(files ? { embeds: [embed], files } : { embeds: [embed] });
      this.lastNowPlayingMessageIdByGuild.set(guildId, sent.id);
      logEvent('status_message_sent', { guildId, messageId: sent.id });
    } catch (error) {
      logError('update_guild_status_failed', error as Error, { guildId });
    }
  }

  // Pinning disabled per latest request; keeping method removed.

  private async buildStatusEmbed(data: {
    currentSong: QueuedSong | null;
    queue: QueuedSong[];
    voiceChannelName?: string;
    startedAt?: number;
    recent?: QueuedSong[];
    lastShuffle?: { by: string; at: number };
  }): Promise<EmbedBuilder> {
    const fields: { name: string; value: string; inline?: boolean }[] = [];
    const base: any = {
      title: data.currentSong ? 'Tocando Agora' : 'Silêncio Encantado',
      description: data.currentSong ? (getRandomPhrase('playing') || `${MusaEmojis.notes} Tocando com carinho!`) : (getRandomPhrase('idle') || `${MusaEmojis.mute || '🔇'} Em silêncio...`),
      color: data.currentSong ? MusaColors.nowPlaying : MusaColors.warning,
      fields,
      timestamp: true
    };

    // Now playing block
    let files: Array<{ attachment: string; name?: string }> | undefined;
    if (data.currentSong) {
      const s = data.currentSong;
      fields.push({ name: `${MusaEmojis.notes} Música`, value: truncateText(s.title, 70), inline: false });
      if (s.creator) fields.push({ name: `${MusaEmojis.microphone} Artista`, value: truncateText(s.creator, 40), inline: true });
      if (s.requestedBy) fields.push({ name: `${MusaEmojis.fairy} Adicionada por`, value: truncateText(s.requestedBy, 30), inline: true });
      if (data.voiceChannelName) fields.push({ name: `${MusaEmojis.headphones} Canal de Voz`, value: data.voiceChannelName, inline: true });

      // Show only total duration (no live progress)
      if (typeof s.duration === 'number' && s.duration > 0) {
        fields.push({ name: `${MusaEmojis.cd} Duração`, value: `${formatDuration(s.duration)}`, inline: true });
      }

      // Thumbnail or fallback attachment
      const thumb = (s as any).thumbnail as string | undefined;
      if (thumb) {
        base.thumbnail = thumb;
      } else {
        const fallbackPath = path.resolve(process.cwd(), 'musa.png');
        if (fs.existsSync(fallbackPath)) {
          base.thumbnail = 'attachment://musa.png';
          files = [{ attachment: fallbackPath, name: 'musa.png' }];
        }
      }
    }

    // Upcoming queue block
    const upcoming = data.queue.slice(0, 6);
    const lines = upcoming.map((q, idx) => {
      const artist = q.creator ? ` — ${truncateText(q.creator, 30)}` : '';
      const by = q.requestedBy ? ` • por ${truncateText(q.requestedBy, 20)}` : '';
      const live = q.isLiveStream ? ` ${MusaEmojis.live}` : '';
      return `${idx + 1}. ${truncateText(q.title, 60)}${artist}${by}${live}`;
    });
    fields.push({
      name: `${MusaEmojis.queue} Próximas Músicas (${data.queue.length})`,
      value: lines.length > 0 ? lines.join('\n') : `${MusaEmojis.search} A fila está vazia — use /play para adicionar músicas!`,
      inline: false
    });

    // Last shuffle info (if available)
    if (data.lastShuffle?.at && data.lastShuffle.by) {
      const d = new Date(data.lastShuffle.at);
      const hh = d.getHours().toString().padStart(2, '0');
      const mm = d.getMinutes().toString().padStart(2, '0');
      fields.push({
        name: `${MusaEmojis.shuffle} Último Shuffle`,
        value: `por ${data.lastShuffle.by} • ${hh}:${mm}`,
        inline: true
      });
    }

    // Footer with last added track (user + time) if available
    const lastAdded = (data as any).lastAdded as { by: string; byId?: string; at: number } | undefined;
    if (lastAdded?.by && lastAdded?.at) {
      const d = new Date(lastAdded.at);
      const hh = d.getHours().toString().padStart(2, '0');
      const mm = d.getMinutes().toString().padStart(2, '0');
      base.footer = `Última música adicionada por ${lastAdded.by} • ${hh}:${mm}`;
      if (lastAdded.byId && this.client) {
        try {
          const u = await this.client.users.fetch(lastAdded.byId);
          base.footerIconUrl = u.displayAvatarURL({ size: 64 });
        } catch { /* ignore */ }
      }
    }

    const embed = createMusaEmbed(base);
    // Recently played block (optional)
    const recent = (data.recent || []).slice(0, 6);
    if (recent.length > 0) {
      const linesRecent = recent.map((q, idx) => {
        const artist = q.creator ? ` — ${truncateText(q.creator, 30)}` : '';
        const by = q.requestedBy ? ` • por ${truncateText(q.requestedBy, 20)}` : '';
        return `${idx + 1}. ${truncateText(q.title, 60)}${artist}${by}`;
      });
      embed.addFields({
        name: `${MusaEmojis.cd} Já Tocaram (${recent.length})`,
        value: linesRecent.join('\n'),
        inline: false
      });
    }
    if (files) (embed as any).__files = files;
    return embed;
  }

  async announceNowPlaying(guildId: string, song: QueuedSong, voiceChannelId?: string, thumbnail?: string) {
    try {
      if (!this.client) return;
      const channelId = botConfig.musaChannelId;
      if (!channelId) return;

      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return;
      const textChannel = channel as TextChannel;

      // Resolve voice channel name if possible
      let voiceName = '';
      if (voiceChannelId) {
        try {
          const vc = await this.client.channels.fetch(voiceChannelId);
          if (vc && 'name' in vc) voiceName = (vc as any).name as string;
        } catch { /* ignore */ }
      }

      const description = getRandomPhrase('playing') || `${MusaEmojis.notes} Tocando com carinho!`;
      const base: any = {
        title: 'Tocando Agora',
        description,
        color: MusaColors.nowPlaying,
        fields: [
          { name: `${MusaEmojis.notes} Música`, value: truncateText(song.title, 70), inline: false },
          ...(voiceName ? [{ name: `${MusaEmojis.microphone} Canal de Voz`, value: voiceName, inline: true }] : [])
        ],
        timestamp: true
      };
      const thumb = thumbnail || (song as any).thumbnail as string | undefined;

      // Prepare optional attachment for fallback thumbnail (musa.png)
      let files: Array<{ attachment: string; name?: string }> | undefined;
      if (thumb) {
        base.thumbnail = thumb;
      } else {
        const fallbackPath = path.resolve(process.cwd(), 'musa.png');
        if (fs.existsSync(fallbackPath)) {
          base.thumbnail = 'attachment://musa.png';
          files = [{ attachment: fallbackPath, name: 'musa.png' }];
        }
      }
      const embed: EmbedBuilder = createMusaEmbed(base);

      // Edit previous now-playing message if exists
      const lastId = this.lastNowPlayingMessageIdByGuild.get(guildId);
      if (lastId) {
        try {
          const msg = await textChannel.messages.fetch(lastId);
          if (files) {
            await msg.edit({ embeds: [embed], files });
          } else {
            await msg.edit({ embeds: [embed] });
          }
          logEvent('now_playing_edited', { guildId, messageId: lastId });
          return;
        } catch {
          // If fetch/edit fails, fall back to sending a new message
        }
      }

      const sent = await textChannel.send(files ? { embeds: [embed], files } : { embeds: [embed] });
      this.lastNowPlayingMessageIdByGuild.set(guildId, sent.id);
      logEvent('now_playing_sent', { guildId, messageId: sent.id });
    } catch (error) {
      logError('announce_now_playing_failed', error as Error, { guildId, title: song.title });
    }
  }
}

export const Announcer = new AnnouncerImpl();
