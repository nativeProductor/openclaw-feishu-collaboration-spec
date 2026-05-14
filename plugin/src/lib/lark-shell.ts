// `lark-shell` — minimal child_process wrapper around the `lark-cli` binary.
//
// Why this exists:
//   Module B needs the bot's own open_id (to compare against mentions[]).
//   Module C needs to fetch recent group messages.
//   Module D will likely need similar IM calls.
// All of them must shell out to the user-installed `lark-cli` (no new npm deps).
//
// Design notes:
//   - We never store credentials here. `lark-cli` is expected to be already
//     authenticated by the user (see lark-shared skill: `lark-cli auth login`).
//   - All calls are best-effort: on non-zero exit, we throw a typed Error
//     with stderr attached, and the caller is expected to log and degrade.
//   - JSON parsing is defensive — `lark-cli` mostly emits JSON, but a few
//     subcommands wrap it. We try `JSON.parse(stdout)`; if it fails we hunt
//     for the first `{` / `[` and try again from there.
//   - Identity flag: caller picks `--as bot` or `--as user`. Default is bot.

import { spawn } from 'node:child_process';

export type LarkShellRunOptions = {
  /** Override `lark-cli` binary path. Defaults to looking up `lark-cli` on $PATH. */
  binary?: string;
  /** Per-call timeout in ms. Default 15s. */
  timeoutMs?: number;
  /** Working directory for the child. Defaults to caller's cwd. */
  cwd?: string;
  /** Extra env vars to merge on top of process.env. */
  env?: Record<string, string>;
};

export type LarkShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export class LarkShellError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  constructor(message: string, opts: { exitCode: number; stderr: string; stdout: string }) {
    super(message);
    this.name = 'LarkShellError';
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
    this.stdout = opts.stdout;
  }
}

/**
 * Run an arbitrary `lark-cli` invocation. Args are passed through verbatim.
 *
 *   await runLarkCli(['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot'])
 *   await runLarkCli(['im', 'chats.messages', 'list', '--chat-id', 'oc_xxx', '--page-size', '25'])
 *
 * Throws `LarkShellError` on non-zero exit, timeout, or spawn failure.
 */
export function runLarkCli(args: string[], opts: LarkShellRunOptions = {}): Promise<LarkShellResult> {
  const binary = opts.binary ?? 'lark-cli';
  const timeoutMs = opts.timeoutMs ?? 15000;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    let child;
    try {
      child = spawn(binary, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(
        new LarkShellError(`spawn(${binary}) failed: ${(err as Error).message}`, {
          exitCode: -1,
          stderr: '',
          stdout: '',
        }),
      );
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      reject(
        new LarkShellError(`lark-cli timed out after ${timeoutMs}ms: ${args.join(' ')}`, {
          exitCode: -1,
          stderr,
          stdout,
        }),
      );
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new LarkShellError(`lark-cli spawn error: ${err.message}`, {
          exitCode: -1,
          stderr,
          stdout,
        }),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        reject(
          new LarkShellError(`lark-cli exited ${exitCode}: ${stderr.trim() || stdout.trim()}`, {
            exitCode,
            stderr,
            stdout,
          }),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * Run lark-cli and parse stdout as JSON. If the leading bytes aren't JSON
 * (e.g. lark-cli prepended a banner line), we recover the first `{` / `[`
 * and parse from there. Throws if no parseable JSON is found.
 */
export async function runLarkCliJson<T = unknown>(
  args: string[],
  opts: LarkShellRunOptions = {},
): Promise<T> {
  const { stdout } = await runLarkCli(args, opts);
  return parseJsonLoose<T>(stdout);
}

export function parseJsonLoose<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('lark-cli returned empty stdout');
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through and try to extract
  }
  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  const candidates: number[] = [];
  if (firstObj !== -1) candidates.push(firstObj);
  if (firstArr !== -1) candidates.push(firstArr);
  if (candidates.length === 0) {
    throw new Error(`lark-cli stdout is not JSON: ${trimmed.slice(0, 200)}`);
  }
  const start = Math.min(...candidates);
  const sliced = trimmed.slice(start);
  try {
    return JSON.parse(sliced) as T;
  } catch (err) {
    throw new Error(
      `lark-cli stdout JSON parse failed (${(err as Error).message}): ${sliced.slice(0, 200)}`,
    );
  }
}
