import {
  VoiceConnection,
  AudioPlayer,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  PlayerSubscription,
  joinVoiceChannel,
  VoiceConnectionStatus,
  StreamType,
} from '@discordjs/voice';
import { VoiceChannel } from 'discord.js';
import { spawn, ChildProcess } from 'child_process';
import { PresenceManager } from './PresenceManager';
import { Announcer } from './Announcer';
import { GuildMusicData, QueuedSong, LoopMode } from '../types/music';
import { MultiSourceManager } from '../services/MultiSourceManager';
import { logEvent, logError, logWarning } from '../utils/logger';
import { botConfig } from '../config';

export class MusicManager {
  private readonly guildData = new Map<string, GuildMusicData>();
  private readonly audioPlayers = new Map<string, AudioPlayer>();
  private readonly voiceConnections = new Map<string, VoiceConnection>();
  private readonly playerSubscriptions = new Map<string, PlayerSubscription>();
  private readonly multiSourceManager: MultiSourceManager;

  private readonly activeStreams = new Set<string>(); // Track active streaming URLs
  private readonly prefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Active yt-dlp pipe processes per guild — killed on stop/skip/disconnect/error
  private readonly activeYtdlpProcesses = new Map<string, ChildProcess>();

  constructor() {
    this.multiSourceManager = new MultiSourceManager();
  }

  async joinVoiceChannel(channel: VoiceChannel): Promise<VoiceConnection | null> {
    try {
      const guildId = channel.guild.id;

      // Check if already connected to this channel
      const existingConnection = this.voiceConnections.get(guildId);
      if (existingConnection && existingConnection.joinConfig.channelId === channel.id) {
        return existingConnection;
      }

      // Create new connection
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator as any,
      });

      // Store connection
      this.voiceConnections.set(guildId, connection);

      // Set up connection event handlers
      connection.on(VoiceConnectionStatus.Ready, () => {
        logEvent('voice_connection_ready', { guildId, channelId: channel.id });
      });

      connection.on(VoiceConnectionStatus.Disconnected, () => {
        logEvent('voice_connection_disconnected', { guildId });
        this.cleanup(guildId);
      });

      connection.on('error', (error) => {
        logError('Voice connection error', error, { guildId });
      });

      logEvent('joined_voice_channel', {
        guildId,
        channelId: channel.id,
        channelName: channel.name,
      });

      return connection;
    } catch (error) {
      logError('Failed to join voice channel', error as Error, {
        guildId: channel.guild.id,
        channelId: channel.id,
      });
      return null;
    }
  }

  async leaveVoiceChannel(guildId: string): Promise<void> {
    try {
      const connection = this.voiceConnections.get(guildId);
      if (connection) {
        connection.destroy();
        this.voiceConnections.delete(guildId);
        logEvent('left_voice_channel', { guildId });
      }

      this.cleanup(guildId);
    } catch (error) {
      logError('Failed to leave voice channel', error as Error, { guildId });
    }
  }

  private cleanup(guildId: string): void {
    // Cancel all timers
    this.cancelInactivityTimer(guildId);
    this.cancelEmptyChannelTimer(guildId);

    // Kill any active yt-dlp pipe process to avoid zombies
    this.killActiveYtdlpProcess(guildId, 'cleanup');

    // Cleanup audio player
    const player = this.audioPlayers.get(guildId);
    if (player) {
      player.stop(true);
      this.audioPlayers.delete(guildId);
    }

    // Cleanup subscription
    const subscription = this.playerSubscriptions.get(guildId);
    if (subscription) {
      subscription.unsubscribe();
      this.playerSubscriptions.delete(guildId);
    }

    // Reset guild data
    const guildData = this.guildData.get(guildId);
    if (guildData) {
      guildData.currentSong = null;
      guildData.queue = [];
      guildData.isPlaying = false;
      guildData.isPaused = false;
    }

    logEvent('music_manager_cleanup', { guildId });
  }

  /**
   * Kill the active yt-dlp pipe process for this guild, if any.
   * Safe to call even when no process is running.
   */
  private killActiveYtdlpProcess(guildId: string, reason: string): void {
    const proc = this.activeYtdlpProcesses.get(guildId);
    if (!proc) return;
    this.activeYtdlpProcesses.delete(guildId);
    try {
      proc.kill('SIGKILL');
      logEvent('youtube_pipe_stream_killed', { guildId, reason });
    } catch {
      // ignore — process may have already exited
    }
  }

  async addToQueue(guildId: string, song: QueuedSong, requestedById?: string): Promise<void> {
    const guildData = this.getGuildData(guildId);

    // Check queue size limit
    if (guildData.queue.length >= botConfig.music.maxQueueSize) {
      throw new Error(
        `🎵 A playlist está lotada! Máximo de ${botConfig.music.maxQueueSize} músicas por vez! 🎶`,
      );
    }
    // Assign stable queueId for advanced play order if missing
    if (typeof guildData.nextQueueId !== 'number') guildData.nextQueueId = 1;
    if (typeof song.queueId !== 'number') song.queueId = guildData.nextQueueId++;

    guildData.queue.push(song);
    // Track last added meta for footer
    guildData.lastAdded = {
      by: song.requestedBy,
      at: Date.now(),
      ...(requestedById ? { byId: requestedById } : {}),
    } as any;

    logEvent('song_added_to_queue', {
      guildId,
      title: song.title,
      service: song.service,
      queuePosition: guildData.queue.length,
      requestedBy: song.requestedBy,
    });

    // Schedule prefetch for upcoming songs
    this.schedulePrefetch(guildId);

    // Update status message (queue changed)
    this.pushStatus(guildId);

    // Start playing if nothing is currently playing
    if (!guildData.isPlaying && !guildData.currentSong) {
      // Prevent disconnect while preparing the next track
      this.cancelInactivityTimer(guildId);
      await this.playNext(guildId);
    }
  }

  // Batch-add songs to queue with a single status update and prefetch scheduling
  async addManyToQueue(guildId: string, songs: QueuedSong[], requestedById?: string): Promise<number> {
    const guildData = this.getGuildData(guildId);

    if (!Array.isArray(songs) || songs.length === 0) return 0;

    const remainingCapacity = Math.max(0, botConfig.music.maxQueueSize - guildData.queue.length);
    const toAdd = songs.slice(0, remainingCapacity);

    if (toAdd.length === 0) {
      throw new Error(
        `🎵 A playlist está lotada! Máximo de ${botConfig.music.maxQueueSize} músicas por vez! 🎶`,
      );
    }

    // Ensure queueId assignment and push all items
    if (typeof guildData.nextQueueId !== 'number') guildData.nextQueueId = 1;
    for (const s of toAdd) {
      if (typeof s.queueId !== 'number') s.queueId = guildData.nextQueueId++;
      guildData.queue.push(s);
    }

    // Track last added meta for footer using the last item
    const last = toAdd[toAdd.length - 1];
    if (last) {
      guildData.lastAdded = {
        by: last.requestedBy,
        at: Date.now(),
        ...(requestedById ? { byId: requestedById } : {}),
      } as any;
    }

    logEvent('songs_added_to_queue_batch', {
      guildId,
      added: toAdd.length,
      requestedBy: last ? last.requestedBy : 'alguém',
      queueLength: guildData.queue.length,
    });

    // Schedule a single prefetch pass
    this.schedulePrefetch(guildId);

    // Update status message once
    this.pushStatus(guildId);

    // Start playing if nothing is currently playing
    if (!guildData.isPlaying && !guildData.currentSong) {
      await this.playNext(guildId);
    }

    return toAdd.length;
  }

  async playNext(guildId: string): Promise<void> {
    const guildData = this.getGuildData(guildId);
    const connection = this.voiceConnections.get(guildId);

    if (!connection) {
      logWarning('No voice connection for guild', { guildId });
      return;
    }

    // Handle loop mode
    if (guildData.loopMode === 'song' && guildData.currentSong) {
      // Replay current song
      await this.playAudio(guildId, guildData.currentSong);
      return;
    }

    // Get next song from queue
    let nextSong: QueuedSong | null = null;

    if (guildData.loopMode === 'queue' && guildData.currentSong) {
      // Add current song back to end of queue
      guildData.queue.push(guildData.currentSong);
    }

    if (guildData.queue.length > 0) {
      nextSong = guildData.queue.shift() || null;
    }

    if (!nextSong) {
      // No more songs, stop playing
      // Clear recent when going truly idle (no next song)
      guildData.currentSong = null;
      delete guildData.currentSongStartedAt;
      guildData.recentlyPlayed = [];
      guildData.isPlaying = false;
      guildData.isPaused = false;

      this.startInactivityTimer(guildId);
      // Start idle presence cycle (rotating phrases)
      try {
        PresenceManager.startIdleCycle();
      } catch {
        /* ignore */
      }

      // Update status message to reflect silence/empty queue
      // Update status (currentSong already null above)
      this.pushStatus(guildId);
      logEvent('queue_finished', { guildId });
      return;
    }

    guildData.currentSong = nextSong;
    await this.playAudio(guildId, nextSong);
  }

  private async playAudio(guildId: string, song: QueuedSong): Promise<void> {
    try {
      const connection = this.voiceConnections.get(guildId);
      if (!connection) {
        throw new Error('No voice connection');
      }

      const guildData = this.getGuildData(guildId);

      logEvent('creating_audio_resource', {
        guildId,
        title: song.title,
        url: song.url,
        service: song.service,
      });

      // Create audio resource based on service type
      let resource;
      if (song.service === 'radio' || song.service === 'internet_archive') {
        resource = await this.createRadioResource(song.url);
      } else if (song.service === 'youtube') {
        resource = await this.createYouTubeStreamResource(guildId, song);
      } else {
        resource = createAudioResource(song.url, {
          inlineVolume: true,
          metadata: {
            title: song.title,
            service: song.service,
          },
        });
      }

      // Set volume
      resource.volume?.setVolume(guildData.volume / 100);

      // Get or create audio player
      let player = this.audioPlayers.get(guildId);
      if (!player) {
        player = createAudioPlayer();
        this.audioPlayers.set(guildId, player);

        // Set up player event handlers
        player.on(AudioPlayerStatus.Playing, () => {
          const data = this.getGuildData(guildId);
          data.isPlaying = true;
          data.isPaused = false;
          data.currentSongStartedAt = Date.now();
          this.cancelInactivityTimer(guildId);

          const current = data.currentSong;
          logEvent('audio_player_playing', {
            guildId,
            title: current?.title,
            service: current?.service,
          });

          // Prefetch upcoming songs when playback stabilizes
          this.schedulePrefetch(guildId, 1500);

          // Update global presence to show current track
          try {
            if (current) {
              const presenceText = current.creator ? `${current.title} — ${current.creator}` : current.title;
              PresenceManager.updatePlayingPresence(presenceText.substring(0, 120));
            }
          } catch {
            /* ignore */
          }

          // Announce in the Musa channel with embed and optional thumbnail
          this.pushStatus(guildId);

          // If current song lacks thumbnail, fetch lightweight metadata and update status
          try {
            if (current && current.service === 'youtube' && !current.thumbnail) {
              const yt = this.multiSourceManager.getService('youtube') as any;
              if (yt?.fetchMeta) {
                void yt
                  .fetchMeta(current.url)
                  .then((meta: any) => {
                    if (meta?.thumbnail && data.currentSong && data.currentSong.url === current.url) {
                      (data.currentSong as any).thumbnail = meta.thumbnail;
                      this.pushStatus(guildId);
                    }
                  })
                  .catch(() => {});
              }
            }
          } catch {
            /* ignore */
          }
        });

        player.on(AudioPlayerStatus.Paused, () => {
          guildData.isPaused = true;
          logEvent('audio_player_paused', { guildId });
        });

        player.on(AudioPlayerStatus.Idle, async () => {
          const data = this.getGuildData(guildId);
          data.isPlaying = false;
          data.isPaused = false;

          // Move current song to recently played
          if (data.currentSong) {
            data.recentlyPlayed = data.recentlyPlayed || [];
            data.recentlyPlayed.unshift(data.currentSong);
            if (data.recentlyPlayed.length > 6) data.recentlyPlayed = data.recentlyPlayed.slice(0, 6);
            this.activeStreams.delete(data.currentSong.url);
          }

          logEvent('audio_player_idle', { guildId });

          // Play next song
          await this.playNext(guildId);
        });

        player.on('error', (error) => {
          const data = this.getGuildData(guildId);
          // Clean up active stream tracking
          if (data.currentSong) {
            this.activeStreams.delete(data.currentSong.url);
          }

          logError('Audio player error', error, {
            guildId,
            title: data.currentSong?.title,
            service: data.currentSong?.service,
          });

          // Try to play next song on error
          void this.playNext(guildId);
        });

        // Subscribe player to connection
        const subscription = connection.subscribe(player);
        if (subscription) {
          this.playerSubscriptions.set(guildId, subscription);
        }
      }

      // Add error listener to the resource
      resource.playStream.on('error', (error: Error) => {
        logError('Audio resource stream error', error, {
          guildId,
          title: song.title,
          url: song.url,
          service: song.service,
        });
      });

      // Play the resource
      player.play(resource);

      logEvent('playing_song', {
        guildId,
        title: song.title,
        service: song.service,
        requestedBy: song.requestedBy,
        queueLength: guildData.queue.length,
      });
    } catch (error) {
      logError('Failed to play audio', error as Error, {
        guildId,
        title: song.title,
        service: song.service,
      });

      // Try next song on error
      await this.playNext(guildId);
    }
  }

  pause(guildId: string): boolean {
    const player = this.audioPlayers.get(guildId);
    if (player && player.state.status === AudioPlayerStatus.Playing) {
      player.pause();
      logEvent('music_paused', { guildId });
      return true;
    }
    return false;
  }

  resume(guildId: string): boolean {
    const player = this.audioPlayers.get(guildId);
    if (player && player.state.status === AudioPlayerStatus.Paused) {
      player.unpause();
      logEvent('music_resumed', { guildId });
      return true;
    }
    return false;
  }

  stop(guildId: string): void {
    const player = this.audioPlayers.get(guildId);
    if (player) {
      player.stop();
    }

    // Kill any active yt-dlp pipe process immediately
    this.killActiveYtdlpProcess(guildId, 'stop');

    const guildData = this.getGuildData(guildId);
    // Cancel any scheduled prefetch for this guild
    const t = this.prefetchTimers.get(guildId);
    if (t) {
      clearTimeout(t);
      this.prefetchTimers.delete(guildId);
      logEvent('prefetch_timer_cleared', { guildId });
    }
    // Clear active stream tracking for current song (if any)
    if (guildData.currentSong) {
      this.activeStreams.delete(guildData.currentSong.url);
    }
    guildData.queue = [];
    guildData.currentSong = null;
    delete guildData.currentSongStartedAt;
    guildData.isPlaying = false;
    guildData.isPaused = false;

    logEvent('music_stopped', { guildId });
    try {
      PresenceManager.startIdleCycle();
    } catch {
      /* ignore */
    }

    // Reflect stopped state in status message
    this.pushStatus(guildId);
  }

  skip(guildId: string): void {
    // Kill yt-dlp pipe process first so the old download doesn't keep running
    this.killActiveYtdlpProcess(guildId, 'skip');

    const player = this.audioPlayers.get(guildId);
    if (player) {
      player.stop(); // This will trigger the 'idle' event and play next song
    }
    logEvent('song_skipped', { guildId });
  }

  setVolume(guildId: string, volume: number): void {
    const guildData = this.getGuildData(guildId);
    guildData.volume = Math.max(0, Math.min(100, volume));

    const player = this.audioPlayers.get(guildId);
    if (player && player.state.status === AudioPlayerStatus.Playing) {
      // Volume changes require restarting the audio
      // This is a limitation of discord.js voice
      logEvent('volume_changed', { guildId, volume: guildData.volume });
    }
  }

  setLoopMode(guildId: string, mode: LoopMode): void {
    const guildData = this.getGuildData(guildId);
    guildData.loopMode = mode;
    logEvent('loop_mode_changed', { guildId, mode });
  }

  shuffleQueue(guildId: string, by?: string, byId?: string): void {
    const guildData = this.getGuildData(guildId);

    // Shuffle array using Fisher-Yates algorithm
    for (let i = guildData.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const itemI = guildData.queue[i];
      const itemJ = guildData.queue[j];
      if (itemI && itemJ) {
        [guildData.queue[i], guildData.queue[j]] = [itemJ, itemI];
      }
    }

    // Mark last shuffle meta
    const ls: any = { by: by || 'alguém', at: Date.now() };
    if (byId) ls.byId = byId;
    guildData.lastShuffle = ls;
    guildData.shuffleEnabled = true;
    logEvent('queue_shuffled', {
      guildId,
      queueLength: guildData.queue.length,
      by: ls.by,
    });

    // Re-evaluate prefetch targets after shuffle
    this.schedulePrefetch(guildId, 250);

    // Update status message after shuffle
    this.pushStatus(guildId);
  }

  // Restore queue to the original insertion order (by stable queueId)
  restoreOriginalOrder(guildId: string, by?: string, byId?: string): void {
    const guildData = this.getGuildData(guildId);
    // Sort by queueId asc, falling back to addedAt when missing
    guildData.queue.sort((a, b) => {
      const ai = typeof a.queueId === 'number' ? a.queueId : Number(a.addedAt?.getTime?.() ?? 0);
      const bi = typeof b.queueId === 'number' ? b.queueId : Number(b.addedAt?.getTime?.() ?? 0);
      return ai - bi;
    });

    guildData.shuffleEnabled = false;
    logEvent('queue_restored_original_order', {
      guildId,
      queueLength: guildData.queue.length,
      by: by || 'alguém',
      byId,
    });

    // Re-evaluate prefetch targets after order change
    this.schedulePrefetch(guildId, 250);

    // Update status message after order change
    this.pushStatus(guildId);
  }

  clearQueue(guildId: string): void {
    const guildData = this.getGuildData(guildId);
    const removedCount = guildData.queue.length;
    guildData.queue = [];
    // Keep recently played as-is here (cleared when truly idle or stop)

    logEvent('queue_cleared', { guildId, removedCount });

    // Reflect cleared queue in status message
    this.pushStatus(guildId);
  }

  /**
   * Fire-and-forget Announcer status update for a guild.
   * Builds the standard payload from guild data + voice connection and swallows errors
   * (status updates are cosmetic — they must never crash the playback path).
   */
  private pushStatus(guildId: string): void {
    try {
      const guildData = this.getGuildData(guildId);
      const connection = this.voiceConnections.get(guildId);
      const payload: any = {
        currentSong: guildData.currentSong,
        queue: guildData.queue,
        recent: guildData.recentlyPlayed,
      };
      const voiceChannelId = connection?.joinConfig?.channelId;
      if (voiceChannelId) payload.voiceChannelId = voiceChannelId;
      if (typeof guildData.currentSongStartedAt === 'number')
        payload.startedAt = guildData.currentSongStartedAt;
      if (guildData.lastShuffle) payload.lastShuffle = guildData.lastShuffle;
      if (guildData.lastAdded) payload.lastAdded = guildData.lastAdded;
      void Announcer.updateGuildStatus(guildId, payload);
    } catch {
      /* ignore — cosmetic */
    }
  }

  // Schedules a prefetch pass for this guild (debounced)
  private schedulePrefetch(guildId: string, delayMs: number = 250): void {
    if (process.env.NODE_ENV === 'test') return;
    if (!botConfig.music.prefetchEnabled) return;
    const existing = this.prefetchTimers.get(guildId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.prefetchTimers.delete(guildId);
      void this.prefetchUpcoming(guildId);
    }, delayMs);
    this.prefetchTimers.set(guildId, timer);
    // Do not keep the event loop alive solely for this timer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (timer as any)?.unref?.();
  }

  // Prefetch thumbnail metadata for upcoming songs (pipe mode: stream URLs not pre-cached)
  private async prefetchUpcoming(guildId: string): Promise<void> {
    const guildData = this.getGuildData(guildId);
    if (!botConfig.music.prefetchEnabled) return;
    if (guildData.queue.length === 0) return;

    // Decide how many to prefetch
    const count = botConfig.music.prefetchAll
      ? guildData.queue.length
      : Math.max(0, botConfig.music.prefetchCount ?? 2);
    const candidates = guildData.queue.slice(0, count);

    let metaUpdated = false;
    for (const song of candidates) {
      // Only prefetch YouTube non-live
      if (song.service !== 'youtube' || song.isLiveStream) continue;
      // Skip if currently streaming this URL
      if (this.activeStreams.has(song.url)) continue;

      // Fetch thumbnail metadata if missing — this is the only active prefetch path
      // (stream URL pre-caching was removed: pipe mode downloads at play-time)
      try {
        if (!song.thumbnail) {
          const yt = this.multiSourceManager.getService('youtube') as any;
          if (yt?.fetchMeta) {
            const meta = await yt.fetchMeta(song.url);
            if (meta?.thumbnail) {
              (song as any).thumbnail = meta.thumbnail;
              metaUpdated = true;
            }
          }
        }
      } catch {
        /* ignore */
      }
    }

    // If we filled any thumbnails, update status once
    if (metaUpdated) {
      this.pushStatus(guildId);
    }
  }

  private getGuildData(guildId: string): GuildMusicData {
    let guildData = this.guildData.get(guildId);
    if (!guildData) {
      guildData = {
        queue: [],
        currentSong: null,
        volume: 50,
        isPlaying: false,
        isPaused: false,
        loopMode: 'off',
        nextQueueId: 1,
        shuffleEnabled: false,
      };
      this.guildData.set(guildId, guildData);
    }
    return guildData;
  }

  private startInactivityTimer(guildId: string): void {
    this.cancelInactivityTimer(guildId);

    const guildData = this.getGuildData(guildId);
    const t = setTimeout(() => {
      logEvent('inactivity_timeout', { guildId });
      void this.leaveVoiceChannel(guildId);
    }, botConfig.music.inactivityTimeout);
    // Do not hold the event loop open for this timer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t as any)?.unref?.();
    guildData.inactivityTimer = t;

    logEvent('inactivity_timer_started', {
      guildId,
      timeout: botConfig.music.inactivityTimeout,
    });
  }

  private cancelInactivityTimer(guildId: string): void {
    const guildData = this.guildData.get(guildId);
    if (guildData?.inactivityTimer) {
      clearTimeout(guildData.inactivityTimer);
      delete guildData.inactivityTimer;
      logEvent('inactivity_timer_cancelled', { guildId });
    }
  }

  private startEmptyChannelTimer(guildId: string): void {
    this.cancelEmptyChannelTimer(guildId);

    const guildData = this.getGuildData(guildId);
    const t = setTimeout(() => {
      logEvent('empty_channel_timeout', { guildId });
      void this.leaveVoiceChannel(guildId);
    }, botConfig.music.emptyChannelTimeout);
    // Do not hold the event loop open for this timer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t as any)?.unref?.();
    guildData.emptyChannelTimer = t;

    logEvent('empty_channel_timer_started', {
      guildId,
      timeout: botConfig.music.emptyChannelTimeout,
    });
  }

  private cancelEmptyChannelTimer(guildId: string): void {
    const guildData = this.guildData.get(guildId);
    if (guildData?.emptyChannelTimer) {
      clearTimeout(guildData.emptyChannelTimer);
      delete guildData.emptyChannelTimer;
      logEvent('empty_channel_timer_cancelled', { guildId });
    }
  }

  // Public method to handle voice state updates from the bot
  handleVoiceChannelEmpty(guildId: string): void {
    logEvent('voice_channel_empty', { guildId });
    this.startEmptyChannelTimer(guildId);
  }

  handleVoiceChannelOccupied(guildId: string): void {
    logEvent('voice_channel_not_empty', { guildId });
    this.cancelEmptyChannelTimer(guildId);
  }

  // Public getters
  getGuildMusicData(guildId: string): GuildMusicData {
    return this.getGuildData(guildId);
  }

  getVoiceConnection(guildId: string): VoiceConnection | undefined {
    return this.voiceConnections.get(guildId);
  }

  getMultiSourceManager(): MultiSourceManager {
    return this.multiSourceManager;
  }

  isConnected(guildId: string): boolean {
    const connection = this.voiceConnections.get(guildId);
    return connection?.state.status === VoiceConnectionStatus.Ready;
  }

  private async createYouTubeStreamResource(guildId: string, song: QueuedSong) {
    // Mark as active stream to prevent conflicts
    this.activeStreams.add(song.url);

    // Kill any previous yt-dlp process for this guild before starting a new one
    this.killActiveYtdlpProcess(guildId, 'new_song_replacing_previous');

    try {
      return await this.createYouTubePipeResource(guildId, song);
    } catch (error) {
      this.activeStreams.delete(song.url);
      logError('YouTube pipe stream failed', error as Error, {
        title: song.title,
        url: song.url,
        guildId,
      });
      throw error;
    }
  }

  /**
   * Create an AudioResource by piping yt-dlp stdout directly into
   * @discordjs/voice — yt-dlp downloads through the WARP proxy and ffmpeg
   * (internal to @discordjs/voice) never touches the network.
   *
   * The yt-dlp process handle is stored in activeYtdlpProcesses so it can be
   * killed on stop/skip/disconnect.
   */
  private async createYouTubePipeResource(guildId: string, song: QueuedSong) {
    const youtubeService = this.multiSourceManager.getService('youtube') as any;

    if (!youtubeService?.spawnPipeStream) {
      throw new Error('YouTubeService.spawnPipeStream not available — cannot create pipe resource');
    }

    logEvent('youtube_pipe_resource_creating', {
      guildId,
      title: song.title,
      url: song.url,
    });

    const ytdlpProc = youtubeService.spawnPipeStream(song);

    if (!ytdlpProc.stdout) {
      // This should never happen given stdio: ['ignore', 'pipe', 'pipe']
      try {
        ytdlpProc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      throw new Error('yt-dlp pipe process has no stdout');
    }

    // Track the process so we can SIGKILL it on stop/skip/disconnect
    this.activeYtdlpProcesses.set(guildId, ytdlpProc);

    logEvent('youtube_pipe_resource_created', {
      guildId,
      title: song.title,
      pid: ytdlpProc.pid,
    });

    // @discordjs/voice StreamType.Arbitrary: voice will spawn its own ffmpeg
    // to transcode whatever format yt-dlp emits (webm/m4a) into opus for Discord.
    const resource = createAudioResource(ytdlpProc.stdout, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
      metadata: { title: song.title },
    });

    // When the play stream ends/closes/errors, also kill the yt-dlp process
    // (in case the resource is discarded before the player fires its own events)
    if (resource.playStream && typeof (resource.playStream as any).once === 'function') {
      (resource.playStream as any).once('close', () => {
        this.killActiveYtdlpProcess(guildId, 'play_stream_closed');
      });
      (resource.playStream as any).once('end', () => {
        this.killActiveYtdlpProcess(guildId, 'play_stream_ended');
      });
      (resource.playStream as any).once('error', () => {
        this.killActiveYtdlpProcess(guildId, 'play_stream_error');
      });
    }

    return resource;
  }

  private async createRadioResource(url: string) {
    const meta = this.sanitizeStreamMeta(url);
    logEvent('creating_radio_resource', { ...meta });

    // Enhanced FFmpeg arguments with aggressive buffering for streaming stability
    const ffmpegArgs = [
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
      '-rw_timeout',
      '30000000', // 30 second timeout (30M microseconds)
      '-analyzeduration',
      '2M',
      '-probesize',
      '5M',
      '-f',
      'mp3',
      '-i',
      url,
      '-bufsize',
      '2M', // 2MB buffer
      '-flush_packets',
      '0', // Don't flush packets immediately
      '-max_delay',
      '5000000', // 5 second max delay
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      'pipe:1',
    ];

    const sanitizedArgs = ffmpegArgs.map((arg) => {
      if (typeof arg === 'string' && (arg.startsWith('http://') || arg.startsWith('https://'))) {
        return '[REDACTED_URL]';
      }
      return arg;
    });
    logEvent('ffmpeg_command', {
      command: 'ffmpeg',
      args: sanitizedArgs,
      ...meta,
    });

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    // Helper to safely terminate FFmpeg
    let ffmpegExited = false;
    const killFfmpeg = (reason: string) => {
      if (ffmpegExited) return;
      try {
        ffmpegProcess.kill('SIGKILL');
        logEvent('radio_ffmpeg_killed', { reason, ...meta });
      } catch {
        /* ignore */
      }
    };

    ffmpegProcess.on('error', (error: Error) => {
      logError('FFmpeg process error', error, {
        pid: ffmpegProcess.pid,
        ...meta,
      });
    });

    ffmpegProcess.on('exit', (code: number | null) => {
      ffmpegExited = true;
      logEvent('ffmpeg_process_exit', { exitCode: code, ...meta });
    });

    if (!ffmpegProcess.stdout) {
      throw new Error('Failed to create ffmpeg process stdout');
    }

    logEvent('ffmpeg_process_created', { pid: ffmpegProcess.pid, ...meta });

    // Create audio resource from ffmpeg output with increased buffer
    const resource = createAudioResource(ffmpegProcess.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: {
        title: 'Stream',
      },
    });

    logEvent('audio_resource_created', { type: 'pcm_stream', ...meta });

    // Ensure FFmpeg is terminated if the player/stream finishes or is stopped
    if (resource.playStream && typeof (resource.playStream as any).once === 'function') {
      (resource.playStream as any).once('close', () => killFfmpeg('radio_play_stream_closed'));
      (resource.playStream as any).once('end', () => killFfmpeg('radio_play_stream_ended'));
      (resource.playStream as any).once('error', () => killFfmpeg('radio_play_stream_error'));
    }

    return resource;
  }

  // Redact stream URL for logs (avoid leaking query/signatures)
  // Still used by createRadioResource
  private sanitizeStreamMeta(url: string): { streamHost: string; streamPath: string } {
    try {
      const u = new URL(url);
      return { streamHost: u.host, streamPath: u.pathname };
    } catch {
      return { streamHost: 'invalid', streamPath: '' };
    }
  }
}
