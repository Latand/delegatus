import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { codexSessionRoots } from "@/lib/accounts/codex";
import { claudeProjectRoots } from "@/lib/accounts/claude";
import { copilotSessionRoots, legacyCopilotHome } from "@/lib/accounts/copilot";

import type { RootKey } from "../types";
import { DEFAULT_SCHEME_CARDS_PER_PROJECT, DEFAULT_SCHEME_PROJECT_CAP } from "./schemeWindow";

const HOME = os.homedir();

/**
 * The per-uid directory Claude Code writes background-task output under,
 * resolved by Claude Code's own rule (its bundled source, 2.1.x):
 * `join(CLAUDE_CODE_TMPDIR || os.tmpdir(), "claude-" + (getuid() ?? 0))`.
 * `os.tmpdir()` follows TMPDIR, so a sandboxed install with its own TMPDIR
 * scans its own tasks and nothing else; with TMPDIR unset it is "/tmp" on
 * Linux and the per-session folder on macOS. The home plays no part in
 * Claude's rule, so it plays none here. There is deliberately no fallback to
 * a live "/tmp/claude-<uid>": that directory belongs to whichever Claude runs
 * without a TMPDIR, and listing it put another setup's tasks on a fresh
 * install (#2169).
 */
export function claudeTasksRootFor(
  env: Readonly<Record<string, string | undefined>> = process.env,
  tmpdir: string = os.tmpdir(),
  uid: number = process.getuid?.() ?? 0,
): string {
  return path.join(env.CLAUDE_CODE_TMPDIR || tmpdir, "claude-" + uid);
}

/**
 * OpenClaw keeps its whole state under one directory: `~/.openclaw` by default,
 * `~/.openclaw-dev` under `--dev` and `~/.openclaw-<name>` under
 * `--profile <name>`. Both flags work by pointing `OPENCLAW_STATE_DIR` at the
 * profile directory, so honouring that variable covers every profile without
 * the scanner learning the flag vocabulary. Resolved per call rather than at
 * import so a relocated state directory takes effect without a restart.
 */
export function openclawStateDir(): string {
  const configured = process.env.OPENCLAW_STATE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".openclaw");
}

/**
 * The transcript directories under an OpenClaw state dir — one per agent id,
 * at `<stateDir>/agents/<agentId>/sessions`. Each is its own scan root so a
 * transcript's `name` stays the bare filename, the way a Codex rollout's does,
 * and so an agent directory holding no sessions costs nothing.
 */
export function openclawSessionRoots(): string[] {
  const agents = path.join(openclawStateDir(), "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agents, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
    .map((entry) => path.join(agents, entry.name, "sessions"))
    .sort();
}

export const ROOTS: Record<RootKey, string> = {
  "codex-sessions": path.join(HOME, ".codex/sessions"),
  "claude-projects": path.join(HOME, ".claude/projects"),
  "claude-tasks": claudeTasksRootFor(),
  /* Every OpenClaw scan root is a descendant of this one; the per-agent roots
     that discovery actually walks come from `openclawSessionRoots()`. */
  "openclaw-sessions": path.join(HOME, ".openclaw/agents"),
  /* The legacy Copilot home's transcripts; every managed account adds its own
     `<home>/session-state` through `copilotSessionRoots()`. */
  "copilot-sessions": path.join(legacyCopilotHome(), "session-state"),
};

/** Every scanner root, including all account homes, with real-path dedupe. */
export function scanRootEntries(): [RootKey, string][] {
  const entries: [RootKey, string][] = [
    ...codexSessionRoots().map((root): [RootKey, string] => ["codex-sessions", root]),
    ...claudeProjectRoots().map((root): [RootKey, string] => ["claude-projects", root]),
    ["claude-tasks", ROOTS["claude-tasks"]],
    ...openclawSessionRoots().map((root): [RootKey, string] => ["openclaw-sessions", root]),
    ...copilotSessionRoots().map((root): [RootKey, string] => ["copilot-sessions", root]),
  ];
  const seen = new Set<string>();
  return entries.filter(([, root]) => { const real = realpathSafe(root) ?? path.resolve(root); if (seen.has(real)) return false; seen.add(real); return true; });
}

export function claudeProjectRootFor(candidate: string): string | null {
  for (const root of claudeProjectRoots()) {
    try { const real = fs.realpathSync(candidate); const rootReal = fs.realpathSync(root); if (real.startsWith(rootReal + path.sep)) return root; } catch { /* unavailable root */ }
  }
  return null;
}

export const EXTS = [".log", ".jsonl", ".output", ".txt"] as const;

export const MAX_CHUNK = 768 * 1024;

/** Default upper bound of the two-dimensional scheme window. */
export const FILE_CAP = DEFAULT_SCHEME_PROJECT_CAP * DEFAULT_SCHEME_CARDS_PER_PROJECT;

function realpathSafe(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Security gate for /api/log: the resolved real path must live under one of
 * the whitelisted roots. Mirrors `path_allowed` in the Python prototype.
 */
export function pathAllowed(candidate: string): boolean {
  const real = realpathSafe(candidate);
  if (!real) return false;
  return scanRootEntries().some(([, root]) => {
    const rootReal = realpathSafe(root);
    return rootReal !== null && real.startsWith(rootReal + path.sep);
  });
}

/** The registered Codex session root containing a path, when it has one. */
export function codexSessionRootFor(candidate: string): string | null {
  for (const root of codexSessionRoots()) {
    try {
      const real = fs.realpathSync(candidate);
      const rootReal = fs.realpathSync(root);
      if (real.startsWith(rootReal + path.sep)) return root;
    } catch {
      continue;
    }
  }
  return null;
}
