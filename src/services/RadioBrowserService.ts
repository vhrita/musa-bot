/**
 * RadioBrowserService — integração com Radio Browser API (https://api.radio-browser.info)
 *
 * Radio Browser é um diretório comunitário FOSS com 50k+ estações de rádio ao vivo.
 * A API é gratuita, sem autenticação, e opera via DNS round-robin em múltiplos mirrors.
 *
 * Regras operacionais respeitadas:
 *  - Nunca hard-codar um servidor: descobrir via /json/servers e sortear aleatoriamente.
 *  - Usar stationuuid (estável entre mirrors), nunca id.
 *  - Enviar User-Agent identificável.
 *  - Reportar click via /json/url/<uuid> quando a estação começa a tocar.
 *  - Cachear a lista de servidores por SERVERS_CACHE_TTL_MS.
 */

import axios, { AxiosInstance } from 'axios';
import { logEvent, logError, logWarning } from '../utils/logger';

export interface RadioBrowserStation {
  stationuuid: string;
  name: string;
  url: string;
  url_resolved: string;
  codec: string;
  bitrate: number;
  country: string;
  countrycode: string;
  tags: string;
  votes: number;
  clickcount: number;
  favicon?: string;
}

interface ServerEntry {
  ip: string;
  name: string;
}

const USER_AGENT = 'musa-bot/2.0 (Discord music bot; github.com/vhrita/musa-bot)';
const SERVERS_DISCOVERY_URL = 'https://all.api.radio-browser.info/json/servers';
const SERVERS_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const REQUEST_TIMEOUT_MS = 8000;

let cachedServers: string[] = [];
let serversCachedAt = 0;

/**
 * Returns a shuffled list of Radio Browser API base URLs.
 * Falls back to a known stable server if discovery fails.
 */
async function discoverServers(): Promise<string[]> {
  if (cachedServers.length > 0 && Date.now() - serversCachedAt < SERVERS_CACHE_TTL_MS) {
    return [...cachedServers];
  }

  try {
    const res = await axios.get<ServerEntry[]>(SERVERS_DISCOVERY_URL, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT },
    });

    if (Array.isArray(res.data) && res.data.length > 0) {
      // Shuffle for load balancing
      const servers = res.data.map((s) => `https://${s.name}`).sort(() => Math.random() - 0.5);

      cachedServers = servers;
      serversCachedAt = Date.now();
      logEvent('radio_browser_servers_discovered', { count: servers.length });
      return [...servers];
    }
  } catch (err) {
    logWarning('Radio Browser server discovery failed, using fallback', {
      error: (err as Error).message,
    });
  }

  // Fallback to known stable servers
  const fallback = [
    'https://de1.api.radio-browser.info',
    'https://de2.api.radio-browser.info',
    'https://nl1.api.radio-browser.info',
  ].sort(() => Math.random() - 0.5);
  return fallback;
}

/**
 * Cria um axios instance apontando pro primeiro mirror disponível.
 * Em falha, tenta o próximo mirror da lista.
 */
async function createApiClient(): Promise<AxiosInstance> {
  const servers = await discoverServers();
  // We return a client pointed at the first server; callers handle retry per-request.
  const baseURL = servers[0] || 'https://de1.api.radio-browser.info';
  return axios.create({
    baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT },
  });
}

/**
 * Executes a request with mirror fallback.
 * Tries each discovered server until one responds successfully.
 */
async function fetchWithFallback<T>(
  path: string,
  params: Record<string, string | number | boolean>,
): Promise<T | null> {
  const servers = await discoverServers();

  for (const serverBase of servers) {
    try {
      const res = await axios.get<T>(`${serverBase}${path}`, {
        params,
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'User-Agent': USER_AGENT },
      });
      return res.data;
    } catch (err) {
      logWarning('Radio Browser mirror failed, trying next', {
        server: serverBase,
        path,
        error: (err as Error).message,
      });
    }
  }

  logError('All Radio Browser mirrors failed', new Error('All mirrors exhausted'), { path });
  return null;
}

/**
 * Searches Radio Browser by station name.
 * Returns stations ordered by clickcount descending (most popular first).
 */
export async function searchByName(name: string, limit = 10): Promise<RadioBrowserStation[]> {
  logEvent('radio_browser_search_by_name', { name, limit });

  const data = await fetchWithFallback<RadioBrowserStation[]>('/json/stations/search', {
    name,
    limit,
    hidebroken: true,
    order: 'clickcount',
    reverse: true,
  });

  if (!data || !Array.isArray(data)) return [];

  // Filter out stations with no resolved URL
  return data.filter((s) => s.url_resolved && s.url_resolved.length > 0);
}

/**
 * Searches Radio Browser by tag/genre (exact match).
 * Returns the single most popular station for that genre.
 */
export async function searchByTag(tag: string, limit = 5): Promise<RadioBrowserStation[]> {
  logEvent('radio_browser_search_by_tag', { tag, limit });

  const data = await fetchWithFallback<RadioBrowserStation[]>(
    `/json/stations/bytag/${encodeURIComponent(tag.toLowerCase())}`,
    {
      limit,
      hidebroken: true,
      order: 'votes',
      reverse: true,
    },
  );

  if (!data || !Array.isArray(data)) return [];
  return data.filter((s) => s.url_resolved && s.url_resolved.length > 0);
}

/**
 * Reports a station click to Radio Browser (good citizenship — improves ranking).
 * Fire-and-forget: errors are swallowed silently.
 */
export async function reportStationClick(stationuuid: string): Promise<void> {
  try {
    const client = await createApiClient();
    await client.get(`/json/url/${stationuuid}`);
    logEvent('radio_browser_click_reported', { stationuuid });
  } catch {
    // Non-critical: ignore
  }
}
