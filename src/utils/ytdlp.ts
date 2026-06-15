/**
 * Shared yt-dlp helpers — single source of truth for args and spawn wrapper.
 *
 * Each call-site adds its own specific flags on top of the base args.
 * This util covers: User-Agent constant, proxy flag, socket-timeout flag.
 * It intentionally does NOT include search-query, --format, -o, --get-url, etc.
 * — those are call-site specific.
 */
import { spawn } from 'child_process';
import { botConfig } from '../config';

/** Single canonical User-Agent passed to every yt-dlp invocation. */
export const YTDLP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36';

/**
 * Returns the common base args shared by all yt-dlp invocations:
 *   --user-agent <UA>
 *   --proxy <proxy>          (only when botConfig.ytdlpProxy is set)
 *   --socket-timeout <n>     (only when called with includeSocketTimeout=true)
 *
 * IMPORTANT: this does NOT append the URL. Every caller must push the URL
 * (and its own specific flags) after calling this function.
 *
 * @param opts.includeSocketTimeout - add --socket-timeout (for meta/playlist calls). Default false.
 * @param opts.includeProxy - add --proxy when configured. Default true.
 */
export function buildYtDlpBaseArgs(
  opts: {
    includeSocketTimeout?: boolean;
    includeProxy?: boolean;
  } = {},
): string[] {
  const { includeSocketTimeout = false, includeProxy = true } = opts;

  const args: string[] = ['--user-agent', YTDLP_USER_AGENT];

  if (includeProxy && botConfig.ytdlpProxy) {
    args.push('--proxy', botConfig.ytdlpProxy);
  }

  if (includeSocketTimeout) {
    args.push('--socket-timeout', String(botConfig.ytdlpSocketTimeoutSeconds ?? 20));
  }

  return args;
}

export interface YtDlpResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Thin Promise wrapper around `spawn('yt-dlp', args)`.
 * Resolves with { stdout, stderr, code } regardless of exit code —
 * let the caller decide what to do with non-zero exits.
 */
export function runYtDlp(args: string[]): Promise<YtDlpResult> {
  return new Promise((resolve) => {
    const yt = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';
    yt.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    yt.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    yt.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    yt.on('error', (err) => resolve({ stdout: '', stderr: (err as Error).message, code: -1 }));
  });
}
