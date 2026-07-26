/**
 * Shannon CLI — AI Penetration Testing Framework
 *
 * Unified CLI supporting two modes:
 *   Local mode: Run from cloned repo — builds locally, mounts prompts, uses ./workspaces/
 *   NPX mode:   Run via npx — pulls from Docker Hub, uses ~/.shannon/
 *
 * Mode is auto-detected based on presence of Dockerfile + docker-compose.yml + prompts/
 * in the current working directory.
 */

import { build } from "./commands/build.js";
import { logs } from "./commands/logs.js";
import { setup } from "./commands/setup.js";
import { start } from "./commands/start.js";
import { status } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import { uninstall } from "./commands/uninstall.js";
import { workspaces } from "./commands/workspaces.js";
import { getMode } from "./mode.js";
import { readFirstTarget } from "./paths.js";
import { getVersion, getVersionLine } from "./version.js";

function blockSudo(): void {
  const isSudo = !!process.env.SUDO_USER;
  const isRoot = process.geteuid?.() === 0;
  if (!isSudo && !isRoot) return;

  if (isSudo) {
    console.error("ERROR: Shannon must not be run with sudo.");
    console.error("Re-run this command as your normal user.");
  } else {
    console.error("ERROR: Shannon must not be run as the root user.");
    console.error("Switch to a regular user account and re-run this command.");
  }
  if (process.platform === "linux") {
    console.error("Configure Docker to run without sudo first:");
    console.error("https://docs.docker.com/engine/install/linux-postinstall");
  }
  process.exit(1);
}

function showHelp(): void {
  const mode = getMode();
  const prefix = mode === "local" ? "./shannon" : "npx @keygraph/shannon";

  console.info(`
Shannon - AI Penetration Testing Framework

Usage:${
    mode === "local"
      ? ""
      : `
  ${prefix} setup                                       Configure credentials`
  }
  ${prefix} start -c <config> [options]                  Start scan from config (all targets inside)
  ${prefix} start --url <url> --repo <path> [options]    Start single-target scan
  ${prefix} stop [--clean] [--yes]                       Stop all running scans
  ${prefix} workspaces                                   List all workspaces
  ${prefix} logs <workspace>                             Show a scan's live log
  ${prefix} status                                       Show running scans${
    mode === "local"
      ? `
  ${prefix} build [--no-cache]                           Build worker image`
      : `
  ${prefix} uninstall [--yes]                            Remove ~/.shannon/ and all data`
  }
  ${prefix} version                                      Show version
  ${prefix} help                                         Show this help

Options for 'start':
  -c, --config <path>       Configuration file (YAML) — required, or use -u + -r
  -u, --url <url>           Primary target URL (derived from config's first target if omitted)
  -r, --repo <path>         Repository path${mode === "local" ? " or bare name" : ""} (derived from config's first target if omitted)
  -o, --output <path>       Copy deliverables to this directory after run
  -w, --workspace <name>    Named workspace (auto-resumes if exists)
      --native              Run worker directly on host (no Docker)
      --pipeline-testing    Use minimal prompts for fast testing
      --debug               Preserve worker container after exit for log inspection

Examples:
  ${prefix} start --native -c my-targets.yaml
  ${prefix} start --native -c my-targets.yaml -w q1-audit
  ${prefix} start -u https://example.com -r ${mode === "local" ? "my-repo" : "./my-repo"}
  ${prefix} logs q1-audit
  ${prefix} stop --clean
${
  mode === "local"
    ? `
State directory: ./workspaces/`
    : `
State directory: ~/.shannon/`
}
Monitor scans at http://localhost:8233
`);
}

interface ParsedStartArgs {
  url: string;
  repo: string;
  repos: string[];
  config?: string;
  workspace?: string;
  output?: string;
  pipelineTesting: boolean;
  debug: boolean;
  native: boolean;
}

function parseStartArgs(argv: string[]): ParsedStartArgs {
  let url = "";
  let repo = "";
  const repos: string[] = [];
  let config: string | undefined;
  let workspace: string | undefined;
  let output: string | undefined;
  let pipelineTesting = false;
  let debug = false;
  let native = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case "-u":
      case "--url":
        if (next && !next.startsWith("-")) {
          url = next;
          i++;
        }
        break;
      case "-r":
      case "--repo":
        if (next && !next.startsWith("-")) {
          if (!repo) repo = next;
          repos.push(next);
          i++;
        }
        break;
      case "-c":
      case "--config":
        if (next && !next.startsWith("-")) {
          config = next;
          i++;
        }
        break;
      case "-w":
      case "--workspace":
        if (next && !next.startsWith("-")) {
          workspace = next;
          i++;
        }
        break;
      case "-o":
      case "--output":
        if (next && !next.startsWith("-")) {
          output = next;
          i++;
        }
        break;
      case "--pipeline-testing":
        pipelineTesting = true;
        break;
      case "--debug":
        debug = true;
        break;
      case "--native":
      case "--no-docker":
        native = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        console.error(
          `Run "${getMode() === "local" ? "./shannon" : "npx @keygraph/shannon"} help" for usage`,
        );
        process.exit(1);
    }
  }

  // If -u / -r were not supplied, derive them from the first target in the config.
  if ((!url || repos.length === 0) && config) {
    const first = readFirstTarget(config);
    if (first) {
      if (!url) url = first.url;
      if (repos.length === 0 && first.repoPath) {
        repo = first.repoPath;
        repos.push(first.repoPath);
      }
    }
  }

  if (!url || repos.length === 0) {
    console.error("ERROR: --url and --repo are required (or supply a -c config with a targets array)");
    console.error(
      `Usage: ${getMode() === "local" ? "./shannon" : "npx @keygraph/shannon"} start -c my-targets.yaml --native`,
    );
    process.exit(1);
  }

  return {
    url,
    repo: repo || repos[0],
    repos,
    pipelineTesting,
    debug,
    native,
    ...(config && { config }),
    ...(workspace && { workspace }),
    ...(output && { output }),
  };
}

// === Main Dispatch ===

blockSudo();

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "start": {
    const parsed = parseStartArgs(args.slice(1));
    await start({ ...parsed, version: getVersion() });
    break;
  }
  case "stop":
    stop(
      args.includes("--clean"),
      args.includes("--yes") || args.includes("-y"),
    );
    break;
  case "logs": {
    const workspaceId = args[1];
    if (!workspaceId) {
      console.error("ERROR: Workspace ID is required");
      console.error(
        `Usage: ${getMode() === "local" ? "./shannon" : "npx @keygraph/shannon"} logs <workspace>`,
      );
      process.exit(1);
    }
    logs(workspaceId);
    break;
  }
  case "workspaces":
    workspaces(getVersion());
    break;
  case "status":
    status();
    break;
  case "setup":
    if (getMode() === "local") {
      console.error(
        "ERROR: setup is only available in npx mode. In local mode, use .env",
      );
      process.exit(1);
    }
    setup();
    break;
  case "build":
    build(args.includes("--no-cache"));
    break;
  case "uninstall":
    if (getMode() === "local") {
      console.error("ERROR: uninstall is only available in npx mode.");
      process.exit(1);
    }
    uninstall(args.includes("--yes") || args.includes("-y"));
    break;
  case "version":
  case "--version":
  case "-v":
    console.info(getVersionLine());
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    showHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
}
