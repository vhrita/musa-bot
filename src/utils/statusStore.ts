/**
 * Persistent storage for the canonical status message ID per guild.
 *
 * Uses a small JSON file at /app/data/status-messages.json (inside the data
 * volume).  All operations are synchronous and wrapped in try/catch — status
 * persistence is cosmetic and must never crash the bot.
 *
 * Volume note: the /app/data directory must be mounted as a persistent volume
 * in the Dokploy / docker-compose deployment so IDs survive container restarts.
 * The entrypoint.sh already runs `mkdir -p /app/data && chown 1001:1001 /app/data`.
 */
import fs from 'fs';
import path from 'path';
import { logEvent, logError } from './logger';

const DATA_PATH = path.resolve('/app/data/status-messages.json');
// Fallback for local dev (process.cwd() likely not /app)
const LOCAL_FALLBACK = path.resolve(process.cwd(), 'data', 'status-messages.json');

function resolvedPath(): string {
  // Use /app/data in production; fall back to ./data in dev/test
  try {
    const dir = path.dirname(DATA_PATH);
    fs.mkdirSync(dir, { recursive: true });
    return DATA_PATH;
  } catch {
    const dir = path.dirname(LOCAL_FALLBACK);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* best-effort */
    }
    return LOCAL_FALLBACK;
  }
}

type StoreData = Record<string, string>; // guildId → messageId

function load(): StoreData {
  try {
    const raw = fs.readFileSync(resolvedPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as StoreData;
    }
    return {};
  } catch {
    return {};
  }
}

function save(data: StoreData): void {
  try {
    const p = resolvedPath();
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    logError('status_store_write_failed', err as Error, {});
  }
}

export function readMessageId(guildId: string): string | undefined {
  try {
    const data = load();
    return data[guildId];
  } catch {
    return undefined;
  }
}

export function writeMessageId(guildId: string, messageId: string): void {
  try {
    const data = load();
    data[guildId] = messageId;
    save(data);
    logEvent('status_store_written', { guildId, messageId });
  } catch (err) {
    logError('status_store_write_failed', err as Error, { guildId });
  }
}

export function deleteMessageId(guildId: string): void {
  try {
    const data = load();
    if (guildId in data) {
      delete data[guildId];
      save(data);
      logEvent('status_store_deleted', { guildId });
    }
  } catch (err) {
    logError('status_store_delete_failed', err as Error, { guildId });
  }
}
