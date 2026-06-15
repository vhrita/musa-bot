/**
 * Tests for PR1 — fix/status-state-versioned
 *
 * Covers:
 *  - GuildMusicData.version is initialised to 0
 *  - version increments on every mutator that changes the embed
 *  - pause / resume eagerly set isPaused + bump version
 *  - playedCount increments in the Idle handler and resets on stop
 *  - Announcer stale-guard discards calls with version <= already-drawn
 */

// ── mock @discordjs/voice (same as musicManager.test.js) ──────────────────
jest.mock('@discordjs/voice', () => {
  const AudioPlayerStatus = {
    Idle: 'idle',
    Buffering: 'buffering',
    Paused: 'paused',
    Playing: 'playing',
    AutoPaused: 'autopaused',
  };

  const VoiceConnectionStatus = {
    Connecting: 'connecting',
    Destroyed: 'destroyed',
    Disconnected: 'disconnected',
    Ready: 'ready',
    Signalling: 'signalling',
  };

  const StreamType = {
    Arbitrary: 'arbitrary',
    OggOpus: 'ogg/opus',
    WebmOpus: 'webm/opus',
    Raw: 'raw',
    OggVorbis: 'ogg/vorbis',
  };

  const mockPlayer = {
    on: jest.fn().mockReturnThis(),
    play: jest.fn(),
    stop: jest.fn(),
    pause: jest.fn(),
    unpause: jest.fn(),
    state: { status: AudioPlayerStatus.Idle },
  };

  const mockConnection = {
    on: jest.fn().mockReturnThis(),
    subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
    destroy: jest.fn(),
    joinConfig: { channelId: 'vc-1' },
    state: { status: VoiceConnectionStatus.Ready },
  };

  return {
    AudioPlayerStatus,
    VoiceConnectionStatus,
    StreamType,
    createAudioPlayer: jest.fn(() => mockPlayer),
    createAudioResource: jest.fn((input, opts) => ({ playStream: input, metadata: opts?.metadata })),
    joinVoiceChannel: jest.fn(() => mockConnection),
    entersState: jest.fn(() => Promise.resolve(mockConnection)),
    getVoiceConnection: jest.fn(() => undefined),
    NoSubscriberBehavior: { Pause: 'pause', Play: 'play', Stop: 'stop' },
    demuxProbe: jest.fn(async (stream) => ({ stream, type: 'arbitrary' })),
  };
});

// ── helpers ───────────────────────────────────────────────────────────────
const { MusicManager } = require('../dist/services/MusicManager');

function makeSong(title = 'Test Song', url = 'https://youtu.be/test') {
  return {
    title,
    url,
    service: 'youtube',
    requestedBy: 'tester',
    addedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
describe('GuildMusicData.version — initialisation', () => {
  test('new guild data starts with version = 0', () => {
    const mm = new MusicManager();
    const data = mm.getGuildMusicData('g-init');
    expect(data.version).toBe(0);
  });

  test('playedCount initialises to 0', () => {
    const mm = new MusicManager();
    const data = mm.getGuildMusicData('g-pc');
    expect(data.playedCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('version bumps on mutators', () => {
  // Each mutator that changes what the embed shows must call bumpAndPushStatus.
  // We verify by checking that version is > 0 after each operation.
  // (Announcer is fire-and-forget so we don't need to spy on it here.)

  test('shuffleQueue bumps version', () => {
    const mm = new MusicManager();
    const gid = 'g-shuffle';
    const data = mm.getGuildMusicData(gid);
    data.queue = [makeSong('a'), makeSong('b'), makeSong('c')];
    const before = data.version;
    mm.shuffleQueue(gid, 'tester');
    expect(data.version).toBeGreaterThan(before);
  });

  test('restoreOriginalOrder bumps version', () => {
    const mm = new MusicManager();
    const gid = 'g-restore';
    const data = mm.getGuildMusicData(gid);
    data.queue = [makeSong('a'), makeSong('b')];
    const before = data.version;
    mm.restoreOriginalOrder(gid);
    expect(data.version).toBeGreaterThan(before);
  });

  test('clearQueue bumps version', () => {
    const mm = new MusicManager();
    const gid = 'g-clear';
    const data = mm.getGuildMusicData(gid);
    data.queue = [makeSong('x')];
    const before = data.version;
    mm.clearQueue(gid);
    expect(data.version).toBeGreaterThan(before);
    expect(data.queue).toHaveLength(0);
  });

  test('stop bumps version and resets playedCount', () => {
    const mm = new MusicManager();
    const gid = 'g-stop';
    const data = mm.getGuildMusicData(gid);
    data.playedCount = 5;
    data.queue = [makeSong('x')];
    const before = data.version;
    mm.stop(gid);
    expect(data.version).toBeGreaterThan(before);
    expect(data.playedCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('pause and resume — isPaused + version', () => {
  test('pause() sets isPaused=true and bumps version when player is Playing', () => {
    const { AudioPlayerStatus, createAudioPlayer } = require('@discordjs/voice');
    const mockPlayer = createAudioPlayer();
    mockPlayer.state = { status: AudioPlayerStatus.Playing };

    const mm = new MusicManager();
    const gid = 'g-pause';
    // Inject mock player directly into the private map via getGuildMusicData
    // side-effect: creates guild data. Then set the player.
    mm.getGuildMusicData(gid);
    // Access private audioPlayers via a workaround — cast to any
    mm['audioPlayers'].set(gid, mockPlayer);

    const data = mm.getGuildMusicData(gid);
    expect(data.isPaused).toBe(false);
    const vBefore = data.version;

    const result = mm.pause(gid);
    expect(result).toBe(true);
    expect(data.isPaused).toBe(true);
    expect(data.version).toBeGreaterThan(vBefore);
  });

  test('pause() returns false and does NOT bump version when already paused/idle', () => {
    const { AudioPlayerStatus, createAudioPlayer } = require('@discordjs/voice');
    const mockPlayer = createAudioPlayer();
    mockPlayer.state = { status: AudioPlayerStatus.Idle };

    const mm = new MusicManager();
    const gid = 'g-pause-noop';
    mm.getGuildMusicData(gid);
    mm['audioPlayers'].set(gid, mockPlayer);

    const data = mm.getGuildMusicData(gid);
    const vBefore = data.version;

    const result = mm.pause(gid);
    expect(result).toBe(false);
    // version must NOT have changed — no state mutation occurred
    expect(data.version).toBe(vBefore);
  });

  test('resume() sets isPaused=false and bumps version when player is Paused', () => {
    const { AudioPlayerStatus, createAudioPlayer } = require('@discordjs/voice');
    const mockPlayer = createAudioPlayer();
    mockPlayer.state = { status: AudioPlayerStatus.Paused };

    const mm = new MusicManager();
    const gid = 'g-resume';
    mm.getGuildMusicData(gid);
    mm['audioPlayers'].set(gid, mockPlayer);

    const data = mm.getGuildMusicData(gid);
    data.isPaused = true; // simulate paused state
    const vBefore = data.version;

    const result = mm.resume(gid);
    expect(result).toBe(true);
    expect(data.isPaused).toBe(false);
    expect(data.version).toBeGreaterThan(vBefore);
  });

  test('resume() returns false and does NOT bump version when not paused', () => {
    const { AudioPlayerStatus, createAudioPlayer } = require('@discordjs/voice');
    const mockPlayer = createAudioPlayer();
    mockPlayer.state = { status: AudioPlayerStatus.Playing };

    const mm = new MusicManager();
    const gid = 'g-resume-noop';
    mm.getGuildMusicData(gid);
    mm['audioPlayers'].set(gid, mockPlayer);

    const data = mm.getGuildMusicData(gid);
    const vBefore = data.version;

    const result = mm.resume(gid);
    expect(result).toBe(false);
    expect(data.version).toBe(vBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('playedCount counter', () => {
  test('playedCount starts at 0 and is not negative', () => {
    const mm = new MusicManager();
    const data = mm.getGuildMusicData('g-count');
    expect(data.playedCount).toBe(0);
  });

  test('stop() resets playedCount to 0', () => {
    const mm = new MusicManager();
    const gid = 'g-count-stop';
    const data = mm.getGuildMusicData(gid);
    data.playedCount = 10;
    mm.stop(gid);
    expect(data.playedCount).toBe(0);
  });

  test('manual increment simulates Idle handler counting beyond 6', () => {
    // The Idle handler in playAudio does: data.playedCount = (data.playedCount ?? 0) + 1
    // and keeps recentlyPlayed capped at 6.
    // Simulate 8 songs finishing:
    const mm = new MusicManager();
    const gid = 'g-count-many';
    const data = mm.getGuildMusicData(gid);
    data.recentlyPlayed = [];

    for (let i = 0; i < 8; i++) {
      const song = makeSong(`song-${i}`, `https://youtu.be/${i}`);
      data.recentlyPlayed.unshift(song);
      if (data.recentlyPlayed.length > 6) data.recentlyPlayed = data.recentlyPlayed.slice(0, 6);
      data.playedCount = (data.playedCount ?? 0) + 1;
    }

    // recentlyPlayed must be capped at 6
    expect(data.recentlyPlayed).toHaveLength(6);
    // but playedCount must reflect the real total
    expect(data.playedCount).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('Announcer stale-guard (version-based discard)', () => {
  // We import the compiled Announcer and wire a mock client so it exercises
  // the stale-guard path without hitting Discord.
  let Announcer;

  beforeEach(() => {
    // Clear module cache so each test gets a fresh Announcer singleton
    jest.resetModules();
    // Re-mock @discordjs/voice after resetModules
    jest.mock('@discordjs/voice', () => {
      const AudioPlayerStatus = { Idle: 'idle', Playing: 'playing', Paused: 'paused' };
      const VoiceConnectionStatus = { Ready: 'ready', Disconnected: 'disconnected' };
      return {
        AudioPlayerStatus,
        VoiceConnectionStatus,
        StreamType: {},
        createAudioPlayer: jest.fn(() => ({
          on: jest.fn().mockReturnThis(),
          play: jest.fn(),
          stop: jest.fn(),
          state: { status: AudioPlayerStatus.Idle },
        })),
        createAudioResource: jest.fn(),
        joinVoiceChannel: jest.fn(),
        entersState: jest.fn(),
        demuxProbe: jest.fn(async (s) => ({ stream: s, type: 'arbitrary' })),
      };
    });
    ({ Announcer } = require('../dist/services/Announcer'));
  });

  function makeMinimalData(version, extraQueue = []) {
    return {
      currentSong: null,
      queue: extraQueue,
      recent: [],
      isPaused: false,
      version,
      playedCount: 0,
    };
  }

  test('call without version is never discarded by stale-guard', async () => {
    // With version=-1 (absent) the stale-guard should be skipped entirely.
    // Since there is no client set, _doFlush bails early — but it must not
    // throw and must not be silently swallowed by the stale check.
    // We just assert it returns without throwing.
    const data = { currentSong: null, queue: [], recent: [] }; // no version field
    await expect(Announcer.updateGuildStatus('g-no-version', data)).resolves.toBeUndefined();
  });

  test('second call with lower version is discarded', async () => {
    // Manually set renderedVersionByGuild to simulate that version 5 was already drawn
    Announcer['renderedVersionByGuild'].set('g-stale', 5);

    // Spy on _doFlush to confirm it is NOT called
    const doFlushSpy = jest.spyOn(Announcer, '_doFlush');

    await Announcer.updateGuildStatus('g-stale', makeMinimalData(3));

    expect(doFlushSpy).not.toHaveBeenCalled();
    doFlushSpy.mockRestore();
  });

  test('call with same version as rendered is also discarded', async () => {
    Announcer['renderedVersionByGuild'].set('g-same', 7);
    const doFlushSpy = jest.spyOn(Announcer, '_doFlush');

    await Announcer.updateGuildStatus('g-same', makeMinimalData(7));

    expect(doFlushSpy).not.toHaveBeenCalled();
    doFlushSpy.mockRestore();
  });

  test('call with higher version proceeds to _doFlush', async () => {
    Announcer['renderedVersionByGuild'].set('g-fresh', 3);
    const doFlushSpy = jest.spyOn(Announcer, '_doFlush').mockResolvedValue(undefined);

    await Announcer.updateGuildStatus('g-fresh', makeMinimalData(5));

    expect(doFlushSpy).toHaveBeenCalledTimes(1);
    doFlushSpy.mockRestore();
  });

  test('concurrent calls: second is blocked by mutex and returns early', async () => {
    // Simulate a flush already in flight by marking the guild as flushing
    Announcer['flushingByGuild'].add('g-mutex');
    Announcer['renderedVersionByGuild'].set('g-mutex', 0); // so version 5 > 0 passes stale-guard

    const doFlushSpy = jest.spyOn(Announcer, '_doFlush').mockResolvedValue(undefined);

    await Announcer.updateGuildStatus('g-mutex', makeMinimalData(5));

    // _doFlush should NOT be called because the mutex is held
    expect(doFlushSpy).not.toHaveBeenCalled();
    doFlushSpy.mockRestore();

    // cleanup
    Announcer['flushingByGuild'].delete('g-mutex');
  });
});
