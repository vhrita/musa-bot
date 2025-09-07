import { Client, ActivityType } from 'discord.js';
import { logEvent } from '../utils/logger';
import { getRandomPhrase } from '../utils/discord';

class PresenceManagerImpl {
  private client: Client | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private idleIntervalMs = 5 * 60 * 1000; // 5 minutes by default

  setClient(client: Client) {
    this.client = client;
  }

  setIdleInterval(minutes: number) {
    this.idleIntervalMs = Math.max(60_000, Math.floor(minutes * 60 * 1000));
  }

  updatePlayingPresence(text: string) {
    if (!this.client?.user) return;
    // Cancel idle cycling if any
    this.stopIdleCycle();
    try {
      this.client.user.setPresence({
        status: 'online',
        activities: [{ name: text, type: ActivityType.Listening }]
      });
    } catch { /* ignore */ }
    logEvent('presence_playing_set', { text });
  }

  startIdleCycle() {
    if (!this.client?.user) return;
    const setOne = () => {
      const phrase = getRandomPhrase('idle') || 'Silêncio...';
      try {
        this.client!.user!.setPresence({
          status: 'idle',
          activities: [{ name: phrase, type: ActivityType.Listening }]
        });
      } catch { /* ignore */ }
      logEvent('presence_idle_set', { phrase });
    };
    // Set immediately and then cycle
    setOne();
    this.stopIdleCycle();
    const t = setInterval(setOne, this.idleIntervalMs);
    // Do not keep the loop alive for presence only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t as any)?.unref?.();
    this.idleTimer = t;
  }

  stopIdleCycle() {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

export const PresenceManager = new PresenceManagerImpl();
