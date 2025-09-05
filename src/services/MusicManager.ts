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
  private readonly streamCacheTTL = 10 * 60 * 1000; // 10 minutes
  private readonly preloadingUrls = new Set<string>(); // Track URLs being preloaded
  private readonly activeStreams = new Set<string>(); // Track active streaming URLs

  constructor() {
    this.multiSourceManager = new MultiSourceManager();
    
    // Clean up expired cache entries every 5 minutes
    setInterval(() => {
      this.cleanupStreamCache();
    }, 5 * 60 * 1000);
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

  async addToQueue(guildId: string, song: QueuedSong): Promise<void> {
    const guildData = this.getGuildData(guildId);
    
    // Check queue size limit
    if (guildData.queue.length >= botConfig.music.maxQueueSize) {
      throw new Error(`🎵 A playlist está lotada! Máximo de ${botConfig.music.maxQueueSize} músicas por vez! 🎶`);
    }

    guildData.queue.push(song);
    
    logEvent('song_added_to_queue', {
      guildId,
      title: song.title,
      service: song.service,
      queuePosition: guildData.queue.length,
      requestedBy: song.requestedBy
    });

    // Start preloading next songs asynchronously (DISABLED temporarily to debug abort errors)
    // this.preloadNextSongs(guildId).catch(error => {
    //   logError('Preload failed', error as Error, { guildId });
    // });

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
      guildData.currentSong = null;
      guildData.isPlaying = false;
      guildData.isPaused = false;
      
      this.startInactivityTimer(guildId);
      
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
        // For radio streams and internet archive, create a stream using ffmpeg
        resource = await this.createRadioResource(song.url);
      } else if (song.service === 'youtube') {
        // Mark as active stream to prevent conflicts
        this.activeStreams.add(song.url);
        
        // For YouTube, try cached stream URL first, then get fresh one
        let streamUrl = this.getCachedStreamUrl(song.url);
        if (!streamUrl) {
          streamUrl = await this.getStreamUrlWithCache(song);
        }
        
        if (streamUrl) {
          // Use FFmpeg for YouTube streams too for better compatibility
          resource = await this.createRadioResource(streamUrl);
        } else {
          this.activeStreams.delete(song.url); // Remove from active if failed
          throw new Error('Failed to get YouTube stream URL');
        }
      } else {
        // For other sources, use regular createAudioResource
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
          guildData.isPlaying = true;
          guildData.isPaused = false;
          this.cancelInactivityTimer(guildId);
          
          logEvent('audio_player_playing', { 
            guildId, 
            title: song.title,
            service: song.service 
          });

          // Start preloading next songs when current song starts playing (DISABLED temporarily)
          // this.preloadNextSongs(guildId).catch(error => {
          //   logError('Preload during playback failed', error as Error, { guildId });
          // });
        });

        player.on(AudioPlayerStatus.Paused, () => {
          guildData.isPaused = true;
          logEvent('audio_player_paused', { guildId });
        });

        player.on(AudioPlayerStatus.Idle, async () => {
          guildData.isPlaying = false;
          guildData.isPaused = false;
          
          // Clean up active stream tracking
          if (guildData.currentSong) {
            this.activeStreams.delete(guildData.currentSong.url);
          }
          
          logEvent('audio_player_idle', { guildId });
          
          // Play next song
          await this.playNext(guildId);
        });

        player.on('error', (error) => {
          // Clean up active stream tracking
          if (guildData.currentSong) {
            this.activeStreams.delete(guildData.currentSong.url);
          }
          
          logError('Audio player error', error, { 
            guildId, 
            title: song.title,
            service: song.service 
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
    guildData.queue = [];
    guildData.currentSong = null;
    guildData.isPlaying = false;
    guildData.isPaused = false;

    logEvent('music_stopped', { guildId });
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

  shuffleQueue(guildId: string): void {
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
    
    logEvent('queue_shuffled', { guildId, queueLength: guildData.queue.length });
  }

  clearQueue(guildId: string): void {
    const guildData = this.getGuildData(guildId);
    const removedCount = guildData.queue.length;
    guildData.queue = [];
    
    logEvent('queue_cleared', { guildId, removedCount });
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
    guildData.inactivityTimer = setTimeout(() => {
      logEvent('inactivity_timeout', { guildId });
      void this.leaveVoiceChannel(guildId);
    }, botConfig.music.inactivityTimeout);

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
    guildData.emptyChannelTimer = setTimeout(() => {
      logEvent('empty_channel_timeout', { guildId });
      void this.leaveVoiceChannel(guildId);
    }, botConfig.music.emptyChannelTimeout);

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

  private async createRadioResource(url: string) {
    logEvent('ffmpeg_process_starting', {
      url,
      command: 'ffmpeg',
      args: ['-i', url, '-f', 's16le', '-ar', '48000', '-ac', '2', '-']
    });

    // For radio streams, create using ffmpeg to ensure compatibility
    const ffmpegProcess = spawn('ffmpeg', [
      '-i', url,
      '-f', 's16le',     // PCM signed 16-bit little-endian
      '-ar', '48000',
      '-ac', '2',
      '-'
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Log ffmpeg errors
    if (ffmpegProcess.stderr) {
      ffmpegProcess.stderr.on('data', (data: Buffer) => {
        logEvent('ffmpeg_stderr', {
          url,
          data: data.toString()
        });
      });
    }

    ffmpegProcess.on('error', (error: Error) => {
      logError('FFmpeg process error', error, { url });
    });

    ffmpegProcess.on('exit', (code: number | null) => {
      logEvent('ffmpeg_process_exit', {
        url,
        exitCode: code
      });
    });

    if (!ffmpegProcess.stdout) {
      throw new Error('Failed to create ffmpeg process stdout');
    }

    logEvent('ffmpeg_process_created', {
      url,
      pid: ffmpegProcess.pid
    });

    // Create audio resource from ffmpeg output
    const resource = createAudioResource(ffmpegProcess.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true
    });

    logEvent('audio_resource_created', {
      url,
      type: 'pcm_stream'
    });

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
    logEvent('stream_cache_set', { songUrl, streamUrl });
  }

  // Preload next songs in queue
  private async preloadNextSongs(guildId: string): Promise<void> {
    const guildData = this.getGuildData(guildId);
    
    // Don't preload if no songs in queue or if already playing/loading
    if (guildData.queue.length === 0) {
      return;
    }

    // Only preload next song when current song is stable (playing for >30s)
    if (guildData.isPlaying && guildData.currentSong) {
      // Wait a bit before preloading to avoid conflicts
      setTimeout(() => {
        this.preloadNextSongsDelayed(guildId);
      }, 30000); // Wait 30 seconds after song starts
      return;
    }

    this.preloadNextSongsDelayed(guildId);
  }

  private async preloadNextSongsDelayed(guildId: string): Promise<void> {
    const guildData = this.getGuildData(guildId);
    const songsToPreload = guildData.queue.slice(0, 1); // Only preload next song

    for (const song of songsToPreload) {
      if (song.service === 'youtube' && !this.getCachedStreamUrl(song.url)) {
        // Don't preload if we're already preloading this URL
        if (!this.preloadingUrls.has(song.url)) {
          this.preloadStreamUrl(song);
        }
      }
    }
  }

  private async preloadStreamUrl(song: QueuedSong): Promise<void> {
    if (this.preloadingUrls.has(song.url)) {
      return; // Already preloading
    }

    // Don't preload if URL is currently being streamed
    if (this.activeStreams.has(song.url)) {
      logEvent('stream_preload_skipped_active', { 
        title: song.title, 
        url: song.url,
        reason: 'already_streaming'
      });
      return;
    }

    this.preloadingUrls.add(song.url);
    
    try {
      logEvent('stream_preload_started', { 
        title: song.title, 
        url: song.url,
        service: song.service 
      });

      const youtubeService = this.multiSourceManager.getService('youtube') as any;
      if (youtubeService?.getStreamUrl) {
        const streamUrl = await youtubeService.getStreamUrl(song);
        if (streamUrl) {
          this.setCachedStreamUrl(song.url, streamUrl);
          logEvent('stream_preload_completed', { 
            title: song.title, 
            url: song.url,
            streamUrl 
          });
        }
      }
    } catch (error) {
      logError('Stream preload failed', error as Error, { 
        title: song.title, 
        url: song.url 
      });
    } finally {
      this.preloadingUrls.delete(song.url);
    }
  }

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
}
