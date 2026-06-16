/**
 * StatusRenderer — per-guild debounce + coalescing + mutex + stale-guard.
 *
 * Replaces the fire-and-forget Announcer.updateGuildStatus path for the
 * persistent status message.  Every mutation in MusicManager calls
 * StatusRenderer.markDirty(guildId, version) which schedules a flush.
 *
 * Flush pipeline per guild:
 *   1. stale-guard: if dirtyVersion <= renderedVersion, skip.
 *   2. mutex: if already flushing, the in-flight flush will re-check at end.
 *   3. take snapshot from MusicManager.
 *   4. renderStatus(snapshot)  ← pure, synchronous.
 *   5. edit or send the canonical message (messageId read from disk).
 *   6. update renderedVersion; release mutex.
 *   7. if dirtyVersion changed during flush, re-schedule immediately.
 *
 * Edge cases handled:
 *   - Unknown Message (10008): message was deleted → recreate + persist new id.
 *   - Rate-limit (429): reschedule after retry_after ms.
 *   - Edit failure (anything else): log and release mutex; next dirty will retry.
 */
import { Client, TextChannel, DiscordAPIError } from 'discord.js';
import { botConfig } from '../config';
import { logEvent, logError } from '../utils/logger';
import { readMessageId, writeMessageId, deleteMessageId } from '../utils/statusStore';
import { renderStatus, StatusSnapshot } from './statusView';

// ─── Guild render state ───────────────────────────────────────────────────────

interface GuildRenderState {
  renderedVersion: number;
  dirtyVersion: number;
  flushing: boolean;
  debounce: ReturnType<typeof setTimeout> | undefined;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 300;

type SnapshotFn = (guildId: string) => StatusSnapshot | null;

class StatusRendererImpl {
  private client: Client | null = null;
  private snapshotFn: SnapshotFn | null = null;
  private readonly state = new Map<string, GuildRenderState>();

  setClient(client: Client): void {
    this.client = client;
  }

  /**
   * Register the snapshot builder from MusicManager.
   * Called once from index.ts after both services are created.
   */
  setSnapshotFn(fn: SnapshotFn): void {
    this.snapshotFn = fn;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Mark the guild status as dirty for a given state version.
   * Schedules a debounced flush; events marked `immediate` still go through
   * the debounce but with a shorter window (~0 ms next-tick).
   */
  markDirty(guildId: string, version: number, immediate = false): void {
    const gs = this.getOrCreate(guildId);
    gs.dirtyVersion = Math.max(gs.dirtyVersion, version);

    // Cancel existing debounce timer
    if (gs.debounce) {
      clearTimeout(gs.debounce);
      gs.debounce = undefined;
    }

    const delay = immediate ? 0 : DEBOUNCE_MS;
    const timer = setTimeout(() => {
      gs.debounce = undefined;
      void this.flush(guildId);
    }, delay);
    // Don't keep event loop alive solely for cosmetic updates
    (timer as any)?.unref?.();
    gs.debounce = timer;
  }

  // ─── Flush pipeline ──────────────────────────────────────────────────────────

  private async flush(guildId: string): Promise<void> {
    const gs = this.getOrCreate(guildId);

    // Stale-guard: nothing new since last render
    if (gs.dirtyVersion <= gs.renderedVersion) {
      logEvent('status_renderer_flush_skipped_stale', {
        guildId,
        dirtyVersion: gs.dirtyVersion,
        renderedVersion: gs.renderedVersion,
      });
      return;
    }

    // Mutex: another flush is in flight — it will re-check at the end
    if (gs.flushing) {
      logEvent('status_renderer_flush_skipped_mutex', { guildId });
      return;
    }

    gs.flushing = true;
    const targetVersion = gs.dirtyVersion;

    try {
      if (!this.client || !this.snapshotFn) return;

      const channelId = botConfig.musaChannelId;
      if (!channelId) return;

      // Take snapshot NOW (immutable)
      const snapshot = this.snapshotFn(guildId);
      if (!snapshot) return;

      // Double-check stale guard using snapshot version
      if (snapshot.version <= gs.renderedVersion) {
        logEvent('status_renderer_flush_skipped_stale_post_snapshot', {
          guildId,
          snapshotVersion: snapshot.version,
          renderedVersion: gs.renderedVersion,
        });
        return;
      }

      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      const textChannel = channel as TextChannel;

      // Render (synchronous — no I/O)
      const output = renderStatus(snapshot);

      // Try to edit the canonical message
      const persistedId = readMessageId(guildId);
      if (persistedId) {
        const edited = await this.tryEdit(guildId, textChannel, persistedId, output, snapshot.version, gs);
        if (edited) return;
        // tryEdit handles recreation internally; if it returns false it already sent
        return;
      }

      // No persisted id → send a new message
      await this.sendNew(guildId, textChannel, output, snapshot.version, gs);
    } catch (error) {
      logError('status_renderer_flush_failed', error as Error, { guildId });
    } finally {
      gs.flushing = false;
      // If more dirty signals arrived while we were flushing, re-schedule
      if (gs.dirtyVersion > targetVersion) {
        logEvent('status_renderer_flush_requeue', { guildId, newDirty: gs.dirtyVersion });
        this.markDirty(guildId, gs.dirtyVersion, true);
      }
    }
  }

  // ─── Message operations ──────────────────────────────────────────────────────

  private async tryEdit(
    guildId: string,
    channel: TextChannel,
    messageId: string,
    output: ReturnType<typeof renderStatus>,
    version: number,
    gs: GuildRenderState,
  ): Promise<boolean> {
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit({ embeds: output.embeds, components: output.components });
      gs.renderedVersion = version;
      logEvent('status_renderer_edited', { guildId, messageId, version });
      return true;
    } catch (err) {
      if (err instanceof DiscordAPIError) {
        if (err.code === 10008) {
          // Unknown Message — it was deleted
          logEvent('status_renderer_message_deleted', { guildId, messageId });
          deleteMessageId(guildId);
          // Recreate
          await this.sendNew(guildId, channel, output, version, gs);
          return true; // handled
        }
        if (err.status === 429) {
          // Rate-limited — respect retry_after
          const retryAfterMs = (err as any).rawError?.retry_after
            ? Math.ceil((err as any).rawError.retry_after * 1000)
            : 2000;
          logEvent('status_renderer_rate_limited', { guildId, retryAfterMs });
          const timer = setTimeout(() => {
            void this.flush(guildId);
          }, retryAfterMs);
          (timer as any)?.unref?.();
          return true; // will retry via timer
        }
      }
      logError('status_renderer_edit_failed', err as Error, { guildId, messageId });
      // Return false so the caller knows edit failed; we will NOT attempt sendNew
      // here to avoid duplicates.  Next dirty will retry.
      return false;
    }
  }

  private async sendNew(
    guildId: string,
    channel: TextChannel,
    output: ReturnType<typeof renderStatus>,
    version: number,
    gs: GuildRenderState,
  ): Promise<void> {
    try {
      const sent = await channel.send({ embeds: output.embeds, components: output.components });
      writeMessageId(guildId, sent.id);
      gs.renderedVersion = version;
      logEvent('status_renderer_sent', { guildId, messageId: sent.id, version });
    } catch (err) {
      logError('status_renderer_send_failed', err as Error, { guildId });
    }
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  private getOrCreate(guildId: string): GuildRenderState {
    let gs = this.state.get(guildId);
    if (!gs) {
      gs = {
        renderedVersion: -1,
        dirtyVersion: -1,
        flushing: false,
        debounce: undefined,
      };
      this.state.set(guildId, gs);
    }
    return gs;
  }
}

export const StatusRenderer = new StatusRendererImpl();
