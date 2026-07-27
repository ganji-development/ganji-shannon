/**
 * Path resolution for --repo and --config arguments.
 *
 * Local mode supports bare repo names (e.g. "my-repo" → ./repos/my-repo).
 * Both modes resolve relative paths against CWD.
 */

import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { isLocal } from './mode.js';

export interface MountPair {
  hostPath: string;
  containerPath: string;
}

/**
 * Hidden subdirectory inside each run directory that holds all internals
 * (deliverables, logs, prompts, session state, browser artifacts). Keeps the
 * run folder's top level clean so only the final report is visible. Must match
 * INTERNAL_DIR in the worker package.
 */
export const INTERNAL_DIR = '.shannon';

/**
 * Filename of the human-facing final report surfaced at the run directory root.
 * Must match FINAL_REPORT_FILENAME in the worker package.
 */
export const FINAL_REPORT_FILENAME = 'Security-Assessment-Report.md';

/**
 * Resolve a run-directory file (e.g. session.json, workflow.log), preferring the
 * current INTERNAL_DIR location and falling back to the legacy run-root location
 * so pre-restructure workspaces keep working. Returns the INTERNAL_DIR path when
 * neither exists — the right default for new runs and error messages.
 */
export function resolveRunFile(runDir: string, filename: string): string {
  const current = path.join(runDir, INTERNAL_DIR, filename);
  if (fs.existsSync(current)) {
    return current;
  }
  const legacy = path.join(runDir, filename);
  if (fs.existsSync(legacy)) {
    return legacy;
  }
  return current;
}

/**
 * Resolve --repo to absolute path and container mount.
 * Dev mode: bare names (no / or . prefix) check ./repos/<name> first.
 */
export function resolveRepo(repoArg: string): MountPair {
  let hostPath: string;

  if (isLocal() && !repoArg.startsWith('/') && !repoArg.startsWith('.')) {
    // Bare name — check ./repos/<name> for backward compatibility
    const barePath = path.resolve('repos', repoArg);
    if (fs.existsSync(barePath)) {
      hostPath = barePath;
    } else {
      console.error(`ERROR: Repository not found at ./repos/${repoArg}`);
      console.error('');
      console.error('Place your target repository under the ./repos/ directory,');
      console.error('or pass an absolute/relative path: -r /path/to/repo');
      process.exit(1);
    }
  } else {
    hostPath = path.resolve(repoArg);
  }

  if (!fs.existsSync(hostPath)) {
    console.error(`ERROR: Repository not found: ${hostPath}`);
    process.exit(1);
  }

  if (!fs.statSync(hostPath).isDirectory()) {
    console.error(`ERROR: Not a directory: ${hostPath}`);
    process.exit(1);
  }

  const basename = path.basename(hostPath);
  return {
    hostPath,
    containerPath: `/repos/${basename}`,
  };
}

/**
 * Resolve --config to absolute path and container mount.
 */
export function resolveConfig(configArg: string): MountPair {
  const hostPath = path.resolve(configArg);

  if (!fs.existsSync(hostPath)) {
    console.error(`ERROR: Config file not found: ${hostPath}`);
    process.exit(1);
  }

  if (!fs.statSync(hostPath).isFile()) {
    console.error(`ERROR: Not a file: ${hostPath}`);
    process.exit(1);
  }

  const basename = path.basename(hostPath);
  return {
    hostPath,
    containerPath: `/app/configs/${basename}`,
  };
}
interface TargetSpec {
  url: string;
  repoPath?: string;
  tier?: string;
}

/** Read the `targets` array from a config YAML, keeping only entries with a URL. */
function readTargets(configPath: string): TargetSpec[] {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = loadYaml(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return [];
    const targets = parsed['targets'];
    if (!Array.isArray(targets)) return [];
    return targets
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map((t) => ({
        url: typeof t['url'] === 'string' ? t['url'] : '',
        ...(typeof t['repo_path'] === 'string' && { repoPath: t['repo_path'] }),
        ...(typeof t['tier'] === 'string' && { tier: t['tier'] }),
      }))
      .filter((t) => t.url.length > 0);
  } catch {
    return [];
  }
}

/** A URL that only resolves on the target host's own loopback, not reachable as a scan entry point. */
function isLoopbackUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Directory that contains all of `relPaths`, computed on the raw (relative) strings so the
 * result stays relative and cwd-independent. For sibling repos like `repos/a` and `repos/b`
 * this yields `repos`. Falls back to `.` when the paths share no common directory.
 */
function commonParentDir(relPaths: string[]): string {
  const segmented = relPaths.map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '').split('/'));
  const first = segmented[0] ?? [];
  let shared = 0;
  for (; shared < first.length; shared++) {
    if (!segmented.every((segs) => segs[shared] === first[shared])) break;
  }
  // Drop the final segment when every path is identical (they point at the same repo dir),
  // otherwise the common prefix already stops at the shared parent directory.
  const allIdentical = segmented.every((segs) => segs.length === first.length && segs.every((s, i) => s === first[i]));
  const prefix = allIdentical ? first.slice(0, -1) : first.slice(0, shared);
  return prefix.join('/') || '.';
}

export interface MultiTargetResolution {
  primaryUrl: string;
  repoArg: string;
}

/**
 * Resolve a config's `targets` array into a single primary entry URL and one repo mount that
 * covers every target's source. The primary URL is the first externally reachable (non-loopback)
 * target so preflight and live probing start from a real entry point; the repo mount is the common
 * parent directory of all target repos, so every agent sees all repositories at once and can reason
 * about how the targets interact. Returns null when the config declares no usable targets.
 */
export function resolveMultiTarget(configPath: string): MultiTargetResolution | null {
  const targets = readTargets(configPath);
  if (targets.length === 0) return null;

  const primary = targets.find((t) => !isLoopbackUrl(t.url)) ?? targets[0];
  if (!primary) return null;

  const repoPaths = [...new Set(targets.map((t) => t.repoPath).filter((p): p is string => !!p))];
  let repoArg = '';
  if (repoPaths.length === 1) {
    repoArg = repoPaths[0] ?? '';
  } else if (repoPaths.length > 1) {
    repoArg = commonParentDir(repoPaths);
  }

  // Prefix relative repo paths with "./" so resolveRepo() treats them as explicit relative
  // paths rather than bare names (which it would expand to ./repos/<name>).
  const normalizedRepo =
    repoArg && !repoArg.startsWith('/') && !repoArg.startsWith('.') ? `./${repoArg}` : repoArg;

  return { primaryUrl: primary.url, repoArg: normalizedRepo };
}
