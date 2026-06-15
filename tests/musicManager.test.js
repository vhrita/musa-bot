/* Basic unit tests for MusicManager using compiled JS from dist */

// @discordjs/voice pulls in @snazzah/davey (native module) which doesn't load
// in the CI/jest environment. Mock the whole package with the subset that
// MusicManager actually uses so the module graph loads cleanly without any
// native bindings.
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
  };
});

const { MusicManager } = require('../dist/services/MusicManager');

function makeSong(title, url) {
  return {
    title,
    url,
    service: 'youtube',
    requestedBy: 'tester',
    addedAt: new Date(),
  };
}

describe('MusicManager basics', () => {
  test('initial guild state has sane defaults', () => {
    const mm = new MusicManager();
    const data = mm.getGuildMusicData('g1');
    expect(data.queue).toEqual([]);
    expect(data.currentSong).toBeNull();
    expect(typeof data.volume).toBe('number');
    expect(data.volume).toBeGreaterThan(0);
  });

  test('shuffleQueue keeps the same items', () => {
    const mm = new MusicManager();
    const gid = 'g2';
    const data = mm.getGuildMusicData(gid);
    data.queue = [
      makeSong('a', 'https://youtu.be/a'),
      makeSong('b', 'https://youtu.be/b'),
      makeSong('c', 'https://youtu.be/c'),
    ];

    const before = data.queue.map((s) => s.url).sort();
    mm.shuffleQueue(gid);
    const after = data.queue.map((s) => s.url).sort();
    expect(after).toEqual(before);
  });

  test('isConnected returns false when no voice connection', () => {
    const mm = new MusicManager();
    expect(mm.isConnected('g3')).toBe(false);
  });
});
