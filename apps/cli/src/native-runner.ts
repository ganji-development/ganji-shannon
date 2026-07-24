/**
 * Native (Non-Docker) Runner
 *
 * Spawns the Temporal worker directly as a host Node.js child process
 * without Docker containers. Supports direct execution on Kali Linux or any host environment.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

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
    env: {
      ...process.env,
    },
  });
}
