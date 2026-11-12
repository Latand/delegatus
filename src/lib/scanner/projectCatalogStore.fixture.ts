/*
 * A synthetic project catalog shaped like the one on a busy installation
 * (2026-11-12: 19,951 records, 15.3 MB): three in four records are Codex
 * rollouts, one in five Claude sessions, the rest background task outputs;
 * about 3,700 working directories under 13 repositories; every record carries
 * a full summary of about 760 bytes and the same resolution state key. Every
 * path, title and identifier is invented.
 */
export const SYNTHETIC_CATALOG_STATE_KEY = "a3f1c9e2b7d4058e6f1a2b3c4d5e6f708192a3b4";

export interface SyntheticCatalog {
  version: 2;
  resolutionVersion: number;
  files: Record<string, Record<string, unknown>>;
}

export function syntheticProjectCatalog(total = 19_951, resolutionVersion = 10): SyntheticCatalog {
  const codex = Math.round(total * 0.7378);
  const claude = Math.round(total * 0.2004);
  const counts: [string, number][] = [["codex-sessions", codex], ["claude-projects", claude], ["claude-tasks", total - codex - claude]];
  const repositories = Array.from({ length: 13 }, (_, index) => `/srv/agents/projects/repository-${String(index).padStart(2, "0")}`);
  const files: Record<string, Record<string, unknown>> = {};
  let n = 0;
  for (const [rootName, count] of counts) {
    for (let index = 0; index < count; index += 1, n += 1) {
      const folder = n % 3_672;
      const repository = folder % 13;
      const projectRoot = repositories[repository]!;
      const cwd = folder < 13 ? projectRoot : `${projectRoot}-worktrees/lane-${String(folder).padStart(5, "0")}`;
      const id = n.toString(16).padStart(12, "0");
      const pathname = rootName === "codex-sessions"
        ? `/srv/agents/.codex/sessions/2026/${String(1 + (n % 12)).padStart(2, "0")}/${String(1 + (n % 28)).padStart(2, "0")}/rollout-2026-10-${String(n).padStart(6, "0")}-0199a1b2-c3d4-7e5f-8a9b-${id}.jsonl`
        : rootName === "claude-projects"
          ? `/srv/agents/.claude/projects/-srv-agents-projects-repository-${String(repository).padStart(2, "0")}/${id.slice(4)}-1a2b-4c3d-8e9f-${id}.jsonl`
          : `/srv/agents/tasks/-srv-agents-projects-repository-${String(repository).padStart(2, "0")}/tasks/b${n.toString(36).padStart(8, "0")}.output`;
      files[pathname] = {
        summaryVersion: 4,
        rootName,
        size: 40_000 + (n * 7_919) % 9_000_000,
        mtimeMs: 1_790_000_000_000 + n * 1_013.25,
        sidecarSize: null,
        sidecarMtimeMs: null,
        stateKey: SYNTHETIC_CATALOG_STATE_KEY,
        project: `repo-${repository.toString(16).padStart(32, "0")}`,
        projectName: `repository-${String(repository).padStart(2, "0")}`,
        projectRoot,
        kind: rootName === "claude-tasks" ? "task" : "session",
        session: rootName !== "claude-tasks",
        ...(folder < 13 ? {} : { worktree: `lane-${String(folder).padStart(5, "0")}` }),
        cwd,
        sessionStartedAt: new Date(1_790_000_000_000 + n * 1_000).toISOString(),
        nativeParentThreadId: n % 9 === 0 ? `0199a1b2-c3d4-7e5f-8a9b-${(n + 1).toString(16).padStart(12, "0")}` : null,
        nativeForkSourceThreadId: null,
        title: `Synthetic conversation ${n}: an invented title of the length a session summary usually has`,
        engine: rootName === "codex-sessions" ? "codex" : rootName === "claude-projects" ? "claude" : "shell",
        fmt: rootName === "codex-sessions" ? "codex" : rootName === "claude-projects" ? "claude" : "plain",
      };
    }
  }
  return { version: 2, resolutionVersion, files };
}
