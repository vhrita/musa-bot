import { 
  VoiceConnection, 
  AudioPlayer, 
  createAudioPlayer, 
  createAudioResource, 
  AudioPlayerStatus, 
  PlayerSubscription,
  joinVoiceChannel,
  VoiceConnectionStatus,
  StreamType
} from '@discordjs/voice';
import { VoiceChannel } from 'discord.js';
import { spawn } from 'child_process';
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
  
  // Stream URL pre-caching system
  private readonly streamCache = new Map<string, { url: string; timestamp: number }>();
  private readonly streamCacheTTL = botConfig.music.streamCacheTTL ?? 10 * 60 * 1000; // default 10 minutes
  private readonly preloadingUrls = new Set<string>(); // Track URLs being preloaded
  private readonly activeStreams = new Set<string>(); // Track active streaming URLs
  private readonly prefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cacheCleanupInterval?: ReturnType<typeof setInterval>;

  constructor() {
    this.multiSourceManager = new MultiSourceManager();
    
    // Clean up expired cache entries every 5 minutes (skip in tests)
    if (process.env.NODE_ENV !== 'test') {
      this.cacheCleanupInterval = setInterval(() => {
        this.cleanupStreamCache();
      }, 5 * 60 * 1000);
      // Do not keep the event loop alive solely for this timer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.cacheCleanupInterval as any)?.unref?.();
    }
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
        channelName: channel.name 
      });

      return connection;
    } catch (error) {
      logError('Failed to join voice channel', error as Error, { 
        guildId: channel.guild.id, 
        channelId: channel.id 
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

  async addToQueue(guildId: string, song: QueuedSong, requestedById?: string): Promise<void> {
    const guildData = this.getGuildData(guildId);
    
    // Check queue size limit
    if (guildData.queue.length >= botConfig.music.maxQueueSize) {
      throw new Error(`🎵 A playlist está lotada! Máximo de ${botConfig.music.maxQueueSize} músicas por vez! 🎶`);
    }

    guildData.queue.push(song);
    // Track last added meta for footer
    guildData.lastAdded = { by: song.requestedBy, at: Date.now(), ...(requestedById ? { byId: requestedById } : {}) } as any;
    
    logEvent('song_added_to_queue', {
      guildId,
      title: song.title,
      service: song.service,
      queuePosition: guildData.queue.length,
      requestedBy: song.requestedBy
    });

    // Schedule prefetch for upcoming songs
    this.schedulePrefetch(guildId);

    // Update status message (queue changed)
    try {
      const connection = this.voiceConnections.get(guildId);
      const voiceChannelId = connection?.joinConfig?.channelId;
      const payload: any = {
        currentSong: guildData.currentSong,
        queue: guildData.queue,
        recent: guildData.recentlyPlayed,
      };
      if (voiceChannelId) payload.voiceChannelId = voiceChannelId;
      if (typeof guildData.currentSongStartedAt === 'number') payload.startedAt = guildData.currentSongStartedAt;
      if (guildData.lastShuffle) payload.lastShuffle = guildData.lastShuffle;
      if (guildData.lastAdded) payload.lastAdded = guildData.lastAdded;
      void Announcer.updateGuildStatus(guildId, payload);
    } catch { /* ignore */ }

    // Start playing if nothing is currently playing
    if (!guildData.isPlaying && !guildData.currentSong) {
      await this.playNext(guildId);
    }
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
      try { PresenceManager.startIdleCycle(); } catch { /* ignore */ }
      
      // Update status message to reflect silence/empty queue
      try {
        const connection = this.voiceConnections.get(guildId);
        const voiceChannelId = connection?.joinConfig?.channelId;
      const payload: any = { currentSong: null, queue: guildData.queue, recent: guildData.recentlyPlayed };
      if (voiceChannelId) payload.voiceChannelId = voiceChannelId;
      if (guildData.lastAdded) payload.lastAdded = guildData.lastAdded;
      void Announcer.updateGuildStatus(guildId, payload);
      } catch { /* ignore */ }

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
        service: song.service
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
            service: song.service
          }
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
            service: current?.service 
          });

          // Prefetch upcoming songs when playback stabilizes
          this.schedulePrefetch(guildId, 1500);

          // Update global presence to show current track
          try {
            if (current) {
              const presenceText = current.creator ? `${current.title} — ${current.creator}` : current.title;
              PresenceManager.updatePlayingPresence(presenceText.substring(0, 120));
            }
          } catch { /* ignore */ }

          // Announce in the Musa channel with embed and optional thumbnail
          try {
            const connection = this.voiceConnections.get(guildId);
            const voiceChannelId = connection?.joinConfig?.channelId;
            const payload: any = { currentSong: current, queue: data.queue, recent: data.recentlyPlayed };
            if (voiceChannelId) payload.voiceChannelId = voiceChannelId;
            if (typeof data.currentSongStartedAt === 'number') payload.startedAt = data.currentSongStartedAt;
            if (data.lastShuffle) payload.lastShuffle = data.lastShuffle;
            if (data.lastAdded) payload.lastAdded = data.lastAdded;
            void Announcer.updateGuildStatus(guildId, payload);
          } catch { /* ignore */ }
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
            service: data.currentSong?.service 
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
          service: song.service
        });
      });

      // Play the resource
      player.play(resource);

      logEvent('playing_song', {
        guildId,
        title: song.title,
        service: song.service,
        requestedBy: song.requestedBy,
        queueLength: guildData.queue.length
      });

    } catch (error) {
      logError('Failed to play audio', error as Error, { 
        guildId, 
        title: song.title,
        service: song.service 
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
    try { PresenceManager.startIdleCycle(); } catch { /* ignore */ }

    // Reflect stopped state in status message
    try {
      const payload: any = { currentSong: null, queue: [] };
      // Keep lastAdded in footer while idle if available
      const data = this.getGuildData(guildId);
      if (data.lastAdded) payload.lastAdded = data.lastAdded;
      void Announcer.updateGuildStatus(guildId, payload);
    } catch { /* ignore */ }
  }

  skip(guildId: string): void {
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
    logEvent('queue_shuffled', { guildId, queueLength: guildData.queue.length, by: ls.by });

    // Re-evaluate prefetch targets after shuffle
    this.schedulePrefetch(guildId, 250);

    // Update status message after shuffle
    try {
      const connection = this.voiceConnections.get(guildId);
      const voiceChannelId = connection?.joinConfig?.channelId;
      const payload: any = {
        currentSong: guildData.currentSong,
        queue: guildData.queue,
        recent: guildData.recentlyPlayed,
      };
      if (voiceChannelId) payload.voiceChannelId = voiceChannelId;
      if (typeof guildData.currentSongStartedAt === 'number') payload.startedAt = guildData.currentSongStartedAt;
      if (guildData.lastShuffle) payload.lastShuffle = guildData.lastShuffle;
      if (guildData.lastAdded) payload.lastAdded = guildData.lastAdded;
      void Announcer.updateGuildStatus(guildId, payload);
    } catch { /* ignore */ }
  }

  clearQueue(guildId: string): void {
    const guildData = this.getGuildData(guildId);
    const removedCount = guildData.queue.length;
    guildData.queue = [];
    // Keep recently played as-is here (cleared when truly idle or stop)
    
    logEvent('queue_cleared', { guildId, removedCount });

    // Reflect cleared queue in status message
    try {
      const connection = this.voiceConnections.get(guildId);
      const voiceChannelId = connection?.joinConfig?.channelId;
      const payload: any = {
        currentSong: guildData.currentSong,
        queue: guildData.queue,
        recent: guildData.recentlyPlayed,
      };
      if (voiceChannelId) payload.voiceChannelId = voiceChannelId;
      if (typeof guildData.currentSongStartedAt === 'number') payload.startedAt = guildData.currentSongStartedAt;
      if (guildData.lastShuffle) payload.lastShuffle = guildData.lastShuffle;
      if (guildData.lastAdded) payload.lastAdded = guildData.lastAdded;
      void Announcer.updateGuildStatus(guildId, payload);
    } catch { /* ignore */ }
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

  // Prefetch stream URLs for upcoming songs
  private async prefetchUpcoming(guildId: string): Promise<void> {
    const guildData = this.getGuildData(guildId);
    if (!botConfig.music.prefetchEnabled) return;
    if (guildData.queue.length === 0) return;

    // Decide how many to prefetch
    const count = botConfig.music.prefetchAll ? guildData.queue.length : Math.max(0, botConfig.music.prefetchCount ?? 2);
    const candidates = guildData.queue.slice(0, count);

    for (const song of candidates) {
      // Only prefetch YouTube non-live
      if (song.service !== 'youtube' || song.isLiveStream) continue;
      // Skip if currently streaming this URL
      if (this.activeStreams.has(song.url)) continue;
      // Skip if cached and fresh
      const cached = this.streamCache.get(song.url);
      if (cached && Date.now() - cached.timestamp < this.streamCacheTTL * 0.8) {
        continue; // fresh enough
      }
      try {
        await this.preloadStreamUrl(song);
      } catch (err) {
        logError('Prefetch failed for song', err as Error, { guildId, title: song.title, url: song.url });
      }
    }
  }

  // Resolve and cache the stream URL for a song
  private async preloadStreamUrl(song: QueuedSong): Promise<void> {
    if (this.preloadingUrls.has(song.url)) return;
    if (this.activeStreams.has(song.url)) return;
    this.preloadingUrls.add(song.url);
    try {
      logEvent('stream_preload_started', { title: song.title, url: song.url, service: song.service });
      const youtubeService = this.multiSourceManager.getService('youtube') as any;
      if (youtubeService?.getStreamUrl) {
        const streamUrl = await youtubeService.getStreamUrl(song);
        if (streamUrl) {
          this.setCachedStreamUrl(song.url, streamUrl);
          logEvent('stream_preload_completed', { title: song.title, url: song.url });
        }
      }
    } finally {
      this.preloadingUrls.delete(song.url);
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
      timeout: botConfig.music.inactivityTimeout 
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
      timeout: botConfig.music.emptyChannelTimeout 
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
    
    try {
      // For YouTube, try cached stream URL first, then get fresh one
      let streamUrl = this.getCachedStreamUrl(song.url);
      // If cached but near expiry (proxy embeds expire parameter), refresh it
      if (streamUrl && this.isProxyStreamNearExpiry(streamUrl)) {
        logEvent('stream_url_near_expiry_refresh', { url: song.url });
        try {
          const refreshed = await this.refreshStreamUrl(song);
          if (refreshed) streamUrl = refreshed;
        } catch (e) {
          // keep older one as fallback
        }
      }
      if (!streamUrl) {
        streamUrl = await this.getStreamUrlWithCache(song);
      }
      
      if (streamUrl) {
        // Use FFmpeg for YouTube streams with retry logic
        return await this.createYouTubeResource(streamUrl, song.title, { guildId, songUrl: song.url });
      } else {
        throw new Error('Failed to get YouTube stream URL');
      }
    } catch (error) {
      logError('YouTube stream failed, trying direct URL fallback', error as Error, {
        title: song.title,
        url: song.url
      });
      
      // Fallback: try direct YouTube URL (may work in some cases)
      try {
        const directStreamUrl = await this.getDirectStreamUrl(song);
        if (directStreamUrl) {
          return await this.createYouTubeResource(directStreamUrl, song.title, { guildId, songUrl: song.url });
        } else {
          throw new Error('All YouTube streaming methods failed');
        }
      } catch (fallbackError) {
        this.activeStreams.delete(song.url);
        throw fallbackError;
      }
    }
  }

  // If proxy URL contains an inner googlevideo with expire param that is close to now, return true
  private isProxyStreamNearExpiry(proxyUrl: string): boolean {
    try {
      if (!proxyUrl.includes('/proxy-stream')) return false;
      const u = new URL(proxyUrl);
      const inner = u.searchParams.get('url');
      if (!inner) return false;
      const innerUrl = new URL(inner);
      const expire = innerUrl.searchParams.get('expire');
      if (!expire) return false;
      const expireSec = parseInt(expire, 10);
      if (Number.isNaN(expireSec)) return false;
      const nowSec = Math.floor(Date.now() / 1000);
      // Consider near expiry if less than 120s remaining
      return expireSec - nowSec <= 120;
    } catch {
      return false;
    }
  }

  private async refreshStreamUrl(song: QueuedSong): Promise<string | null> {
    const youtubeService = this.multiSourceManager.getService('youtube') as any;
    if (youtubeService?.getStreamUrl) {
      const streamUrl = await youtubeService.getStreamUrl(song);
      if (streamUrl) {
        this.setCachedStreamUrl(song.url, streamUrl);
        return streamUrl;
      }
    }
    return null;
  }

  private async createYouTubeResource(streamUrl: string, title: string, ctx?: { guildId?: string; songUrl?: string }) {
    const meta = this.sanitizeStreamMeta(streamUrl);
    logEvent('creating_youtube_resource', { title, ...meta, ...(ctx || {}) });

    // Simplified FFmpeg arguments without aggressive reconnection that causes multiple simultaneous requests
    const ffmpegArgs = [
      '-loglevel', 'error',              // Reduce FFmpeg logging
      '-re',                             // Read input at native frame rate (prevents rushing)
      '-i', streamUrl,
      '-acodec', 'pcm_s16le',           // Direct PCM conversion
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1'
    ];

    const sanitizedArgs = ffmpegArgs.map(arg => {
      if (typeof arg === 'string' && (arg.startsWith('http://') || arg.startsWith('https://'))) {
        return '[REDACTED_URL]';
      }
      return arg;
    });
    logEvent('youtube_ffmpeg_command', {
      title,
      command: 'ffmpeg',
      args: sanitizedArgs,
      ...meta,
      ...(ctx || {})
    });

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'] // Capture stderr for debugging
    });

    // Helper to safely terminate FFmpeg to avoid lingering processes
    let ffmpegExited = false;
    const killFfmpeg = (reason: string) => {
      if (ffmpegExited) return;
      try {
        ffmpegProcess.kill('SIGKILL');
        logEvent('youtube_ffmpeg_killed', { title, reason, ...meta, ...(ctx || {}) });
      } catch {
        // ignore
      }
    };

    // Log FFmpeg errors to understand what's happening
    if (ffmpegProcess.stderr) {
      ffmpegProcess.stderr.on('data', (data) => {
        const errorMsg = data.toString();
        if (errorMsg.includes('HTTP error') || errorMsg.includes('Server returned')) {
          logError('FFmpeg HTTP error', new Error(errorMsg), {
            title,
            ...meta,
            ...(ctx || {})
          });
        }
      });
    }

    ffmpegProcess.on('error', (error: Error) => {
      logError('YouTube FFmpeg process error', error, {
        title,
        pid: ffmpegProcess.pid,
        ...meta,
        ...(ctx || {})
      });
    });

    ffmpegProcess.on('exit', (code: number | null) => {
      ffmpegExited = true;
      logEvent('youtube_ffmpeg_process_exit', {
        title,
        exitCode: code,
        ...meta,
        ...(ctx || {})
      });
    });

    if (!ffmpegProcess.stdout) {
      throw new Error('Failed to create YouTube ffmpeg process stdout');
    }

    logEvent('youtube_ffmpeg_process_created', {
      title,
      pid: ffmpegProcess.pid,
      ...meta,
      ...(ctx || {})
    });

    // Create audio resource from ffmpeg output
    const resource = createAudioResource(ffmpegProcess.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: {
        title: title
      }
    });

    logEvent('youtube_audio_resource_created', {
      title,
      type: 'pcm_stream',
      ...meta,
      ...(ctx || {})
    });

    // Ensure FFmpeg is terminated if the player/stream finishes or is stopped
    if (resource.playStream && typeof (resource.playStream as any).once === 'function') {
      (resource.playStream as any).once('close', () => killFfmpeg('play_stream_closed'));
      (resource.playStream as any).once('end', () => killFfmpeg('play_stream_ended'));
      (resource.playStream as any).once('error', () => killFfmpeg('play_stream_error'));
    }

    return resource;
  }

  private async getDirectStreamUrl(song: QueuedSong): Promise<string> {
    logEvent('attempting_direct_stream_url', { title: song.title, url: song.url });
    
    // Try to get stream URL with bypass=true to get direct YouTube URL
    const youtubeService = this.multiSourceManager.getService('youtube') as any;
    if (youtubeService?.getStreamUrlDirect) {
      return await youtubeService.getStreamUrlDirect(song);
    }
    
    // If no direct method available, return empty (will cause fallback to fail)
    throw new Error('Direct stream URL not available');
  }

  private async createRadioResource(url: string) {
    const meta = this.sanitizeStreamMeta(url);
    logEvent('creating_radio_resource', { ...meta });

    // Enhanced FFmpeg arguments with aggressive buffering for streaming stability
    const ffmpegArgs = [
      '-reconnect', '1',
      '-reconnect_streamed', '1', 
      '-reconnect_delay_max', '5',
      '-rw_timeout', '30000000', // 30 second timeout (30M microseconds)
      '-analyzeduration', '2M',
      '-probesize', '5M',
      '-f', 'mp3',
      '-i', url,
      '-bufsize', '2M', // 2MB buffer
      '-flush_packets', '0', // Don't flush packets immediately
      '-max_delay', '5000000', // 5 second max delay
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1'
    ];

    const sanitizedArgs = ffmpegArgs.map(arg => {
      if (typeof arg === 'string' && (arg.startsWith('http://') || arg.startsWith('https://'))) {
        return '[REDACTED_URL]';
      }
      return arg;
    });
    logEvent('ffmpeg_command', {
      command: 'ffmpeg',
      args: sanitizedArgs,
      ...meta
    });

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'ignore']
    });

    // Helper to safely terminate FFmpeg
    let ffmpegExited = false;
    const killFfmpeg = (reason: string) => {
      if (ffmpegExited) return;
      try {
        ffmpegProcess.kill('SIGKILL');
        logEvent('radio_ffmpeg_killed', { reason, ...meta });
      } catch { /* ignore */ }
    };

    ffmpegProcess.on('error', (error: Error) => {
      logError('FFmpeg process error', error, { pid: ffmpegProcess.pid, ...meta });
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
        title: 'Stream'
      }
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

  // Stream URL caching and preloading methods
  private cleanupStreamCache(): void {
    const now = Date.now();
    for (const [key, cache] of this.streamCache.entries()) {
      if (now - cache.timestamp > this.streamCacheTTL) {
        this.streamCache.delete(key);
        logEvent('stream_cache_expired', { url: key });
      }
    }
  }

  private getCachedStreamUrl(songUrl: string): string | null {
    const cache = this.streamCache.get(songUrl);
    if (cache && Date.now() - cache.timestamp < this.streamCacheTTL) {
      logEvent('stream_cache_hit', { url: songUrl });
      return cache.url;
    }
    return null;
  }

  private setCachedStreamUrl(songUrl: string, streamUrl: string): void {
    this.streamCache.set(songUrl, {
      url: streamUrl,
      timestamp: Date.now()
    });
    const meta = this.sanitizeStreamMeta(streamUrl);
    logEvent('stream_cache_set', { songUrl, ...meta });
  }

  // (Old disabled preload code removed and replaced by prefetchUpcoming/preloadStreamUrl)

  // Enhanced getStreamUrl with caching
  private async getStreamUrlWithCache(song: QueuedSong): Promise<string> {
    // Check cache first
    const cachedUrl = this.getCachedStreamUrl(song.url);
    if (cachedUrl) {
      return cachedUrl;
    }

    // Get from service
    const youtubeService = this.multiSourceManager.getService('youtube') as any;
    if (youtubeService?.getStreamUrl) {
      const streamUrl = await youtubeService.getStreamUrl(song);
      if (streamUrl) {
        this.setCachedStreamUrl(song.url, streamUrl);
        return streamUrl;
      }
    }

    throw new Error('Failed to get stream URL');
  }

  // Redact stream URL for logs (avoid leaking query/signatures)
  private sanitizeStreamMeta(url: string): { streamHost: string; streamPath: string; expire?: number } {
    try {
      const u = new URL(url);
      const expire = u.searchParams.get('expire');
      const meta: { streamHost: string; streamPath: string; expire?: number } = {
        streamHost: u.host,
        streamPath: u.pathname
      };
      if (expire && !Number.isNaN(Number(expire))) {
        meta.expire = Number(expire);
      }
      return meta;
    } catch {
      return { streamHost: 'invalid', streamPath: '' };
    }
  }
}
