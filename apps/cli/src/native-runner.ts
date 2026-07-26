/**
 * Native (Non-Docker) Runner
 *
 * Manages Temporal server and worker process directly on the host without Docker.
 * Supports Kali Linux and any Node.js environment.
 *
 * Temporal server lifecycle:
 *   - Checks if :7233 is already reachable (user may already have it running).
 *   - If not, spawns `temporal server start-dev` in the background.
 *   - Waits up to 30s for it to become ready before launching the worker.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const TEMPORAL_ADDRESS = '127.0.0.1';
const TEMPORAL_PORT = 7233;
const TEMPORAL_DB_PATH = path.resolve('.temporal-data', 'temporal.db');

/** Check if Temporal's gRPC port is open and accepting connections. */
async function isTemporalReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: TEMPORAL_ADDRESS, port: TEMPORAL_PORT });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    // 500ms timeout per probe
    sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
  });
}

let _temporalProc: ChildProcess | null = null;

/**
 * Ensure the Temporal dev server is running natively.
 * If already reachable on :7233, returns immediately (user's own instance).
 * Otherwise spawns `temporal server start-dev` and waits up to 30s.
 */
export async function ensureNativeTemporal(): Promise<void> {
  if (await isTemporalReachable()) {
    console.info('Temporal already running on :7233.');
    return;
  }

  // Verify `temporal` binary is available
  try {
    execFileSync('temporal', ['--version'], { stdio: 'pipe' });
  } catch {
    console.error('ERROR: `temporal` CLI not found.');
    console.error('Install it: https://docs.temporal.io/cli#installation');
    console.error('  e.g. on Kali/Debian:');
    console.error('    curl -sSf https://temporal.download/cli/install | sh');
    process.exit(1);
  }

  console.info('Starting Temporal server (native)...');

  // Ensure the data dir exists
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.dirname(TEMPORAL_DB_PATH), { recursive: true });
  } catch { /* ignore */ }

  _temporalProc = spawn(
    'temporal',
    [
      'server', 'start-dev',
      '--db-filename', TEMPORAL_DB_PATH,
      '--ip', '127.0.0.1',
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    },
  );

  _temporalProc.stderr?.on('data', (chunk: Buffer) => {
    // Surface fatal startup errors only
    const line = chunk.toString();
    if (/error|fatal/i.test(line)) process.stderr.write(`[temporal] ${line}`);
  });

  _temporalProc.once('error', (err) => {
    console.error(`Failed to start Temporal: ${err.message}`);
    process.exit(1);
  });

  // Wait for :7233 to become reachable (up to 30s)
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await isTemporalReachable()) {
      console.info('Temporal is ready.');
      return;
    }
    if (i === 0) process.stdout.write('Waiting for Temporal');
    else process.stdout.write('.');
  }
  process.stdout.write('\n');
  console.error('ERROR: Timed out waiting for Temporal to start (30s).');
  process.exit(1);
}

/** Send SIGTERM to the Temporal process we started (if any). */
export function stopNativeTemporal(): void {
  if (_temporalProc && !_temporalProc.killed) {
    _temporalProc.kill('SIGTERM');
    _temporalProc = null;
  }
}

export interface NativeWorkerOptions {
  url: string;
  repoPath: string;
  taskQueue: string;
  workspace: string;
  configPath?: string;
  outputDir?: string;
  pipelineTesting?: boolean;
}

export function spawnNativeWorker(opts: NativeWorkerOptions): ChildProcess {
  const workerScript = path.resolve('apps/worker/dist/temporal/worker.js');
  const args = [
    workerScript,
    opts.url,
    opts.repoPath,
    '--task-queue',
    opts.taskQueue,
    '--workspace',
    opts.workspace,
  ];

  if (opts.configPath) {
    args.push('--config', opts.configPath);
  }
  if (opts.outputDir) {
    args.push('--output', opts.outputDir);
  }
  if (opts.pipelineTesting) {
    args.push('--pipeline-testing');
  }

  return spawn('node', args, {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env },
  });
}
