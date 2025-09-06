/* Basic unit tests for MusicManager using compiled JS from dist */

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

    const before = data.queue.map(s => s.url).sort();
    mm.shuffleQueue(gid);
    const after = data.queue.map(s => s.url).sort();
    expect(after).toEqual(before);
  });

  test('isConnected returns false when no voice connection', () => {
    const mm = new MusicManager();
    expect(mm.isConnected('g3')).toBe(false);
  });
});
