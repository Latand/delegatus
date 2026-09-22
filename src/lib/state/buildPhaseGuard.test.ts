import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  closeStateMutationActivationForTests,
  nextBuildPhase,
  openStateMutationActivation,
  stateMutationRefusal,
} from "./stateMutationBarrier";

/*
 * #1905. A lane ran `bun run build` in its worktree and the build imported the
 * operator's LIVE account state: eight files were renamed away and replaced by
 * tombstone directories, and production could not select an account for
 * seventy minutes.
 *
 * The path was `next build` -> `collectAppRouteSegments` -> the module load of
 * `src/app/api/accounts/codex/limits/route.ts` -> `@/lib/accounts/claudeLogin`
 * building its supervisor at module scope -> `reconcilePersisted()` ->
 * `readAccountSource` -> the lazy first-boot import. Nothing in that chain
 * named a state directory, so it resolved the operator's real one.
 *
 * These cases run the real module load in a child process against a seeded
 * config root that WOULD import — a release target and an activated hot-state
 * authority stand beside eight legacy files — and compare a recursive digest
 * of the whole root before and after. Every byte of the root is the assertion,
 * so a write anywhere in it fails the test, not only a tombstone.
 */

const CHILD = path.join(import.meta.dir, "buildPhaseGuard.child.ts");
const RELEASE_REVISION = "a".repeat(40);
const roots: string[] = [];

afterEach(() => {
  closeStateMutationActivationForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A config root shaped like the operator's, in a temp directory. */
function seededRoot(): { root: string; state: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-build-phase-"));
  roots.push(root);
  const state = path.join(root, "agent-log-viewer", "state");
  fs.mkdirSync(state, { recursive: true });
  const write = (name: string, body: unknown) =>
    fs.writeFileSync(path.join(state, name), `${JSON.stringify(body, null, 2)}\n`);
  write("viewer-release.json", {
    endpoint: "http://127.0.0.1:8898",
    revision: RELEASE_REVISION,
    hotStateBackend: "sqlite-v1",
  });
  write("hot-state-authority.json", {
    schemaVersion: 1,
    epoch: 1,
    mode: "sqlite",
    releaseRevision: RELEASE_REVISION,
    updatedAt: "2026-09-20T00:00:00.000Z",
    activationReadyAt: "2026-09-20T00:00:00.000Z",
    releaseReadyAt: "2026-09-20T00:00:00.000Z",
  });
  write("claude-accounts.json", {
    version: 1,
    active: "seeded-alpha",
    accounts: [{ id: "seeded-alpha", label: "seeded-alpha", kind: "managed", createdAt: 1 }],
    retired: [],
    removals: [],
  });
  write("codex-accounts.json", { version: 1, active: null, accounts: [], retired: [], removals: [] });
  write("account-project-bindings.json", { version: 1, bindings: [] });
  write("account-project-overrides.json", { version: 1, overrides: [] });
  write("spawn-admission-fences.json", { version: 1, fences: [] });
  write("account-mutation-revision.json", { revision: 1 });
  write("claude-auth-operations.json", { version: 1, operations: [] });
  write("codex-login-attempts.json", { version: 1, attempts: [] });
  /* The bridge stores (#1870 slice 4): the report log, the unscoped channel
     and one scoped channel, which the child reads through the bridge store. */
  write("bridge-reports.json", { schemaVersion: 1, lastSeq: 1, trimmedThroughSeq: 0, reports: [], retired: [] });
  write("bridge.json", { schemaVersion: 1, rootId: "root_seeded", managerRecordRef: "orchestrator", managerReportCursor: 1, updatedAt: "2026-09-20T00:00:00.000Z" });
  fs.mkdirSync(path.join(state, "bridge-channels"));
  write(path.join("bridge-channels", `${crypto.createHash("sha256").update("seeded-project\0seeded-seat").digest("hex").slice(0, 32)}.json`), {
    schemaVersion: 1,
    rootId: "root_seeded",
    project: "seeded-project",
    seatConversationId: "seeded-seat",
    managerRecordRef: "orchestrator",
    managerReportCursor: 1,
    updatedAt: "2026-09-20T00:00:00.000Z",
  });
  /* The operator-facing small stores (#1870 slice 5), which the child reads
     through their stores the way the MCP tools and the routes do. */
  write("attention.json", { schemaVersion: 1, revision: 57, updatedAt: "2026-09-20T00:00:00.000Z", requests: [] });
  write("reply-suggestions.json", { schemaVersion: 1, revision: 9, updatedAt: "2026-09-20T00:00:00.000Z", sets: [], admissions: [] });
  write("seat-tick-settings.json", { version: 1, projects: {} });
  return { root, state };
}

/** Every entry under `root`, by relative path, with a digest for each file. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      const key = path.relative(root, full);
      if (entry.isDirectory()) {
        entries[key] = "dir";
        walk(full);
      } else if (entry.isSymbolicLink()) {
        entries[key] = `link:${fs.readlinkSync(full)}`;
      } else {
        entries[key] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      }
    }
  };
  walk(root);
  return entries;
}

async function loadModules(
  root: string,
  options: { buildPhase: boolean; activated: boolean; mode?: string; owner?: string },
): Promise<{ exit: number; out: string; error: string }> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, XDG_CONFIG_HOME: root };
  delete env.LLV_STATE_DIR;
  delete env.NEXT_PHASE;
  delete env.LLV_STATE_OWNER;
  if (options.owner) env.LLV_STATE_OWNER = options.owner;
  if (options.buildPhase) env.NEXT_PHASE = "phase-production-build";
  env.NEXT_RUNTIME = "nodejs";
  const proc = Bun.spawn({
    cmd: [process.execPath, CHILD, options.mode ?? (options.activated ? "activated" : "module-load")],
    cwd: path.join(import.meta.dir, "..", "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [out, error, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, out, error };
}

describe("a build-phase module load never mutates state (#1905)", () => {
  test("loading the route's modules under NEXT_PHASE=phase-production-build writes nothing", async () => {
    const { root, state } = seededRoot();
    const before = snapshot(root);
    const run = await loadModules(root, { buildPhase: true, activated: false });
    expect(run.error).not.toContain("StateMutationRefusedError");
    expect(run.exit).toBe(0);
    /* The route still loads and still reads: it reads the legacy file, the
       answer an unimported store has always given. */
    expect(JSON.parse(run.out.trim()) as { kind: string }).toEqual({ kind: "legacy" });
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(state, "state.sqlite"))).toBe(false);
    expect(fs.lstatSync(path.join(state, "claude-accounts.json")).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(state, "bridge-reports.json")).isFile()).toBe(true);
    for (const name of ["attention.json", "reply-suggestions.json", "seat-tick-settings.json"]) {
      expect(fs.lstatSync(path.join(state, name)).isFile()).toBe(true);
    }
  }, 30_000);

  test("the same load outside a build writes nothing either: only the Viewer's activation imports", async () => {
    const { root } = seededRoot();
    const before = snapshot(root);
    const run = await loadModules(root, { buildPhase: false, activated: false });
    expect(run.exit).toBe(0);
    expect(JSON.parse(run.out.trim()) as { kind: string }).toEqual({ kind: "legacy" });
    expect(snapshot(root)).toEqual(before);
  }, 30_000);

  test("the seeded root does import once the activation opens the gate", async () => {
    const { root, state } = seededRoot();
    const run = await loadModules(root, { buildPhase: false, activated: true });
    expect(run.exit).toBe(0);
    expect(JSON.parse(run.out.trim()) as { kind: string }).toEqual({ kind: "collection" });
    expect(fs.existsSync(path.join(state, "state.sqlite"))).toBe(true);
    expect(fs.lstatSync(path.join(state, "claude-accounts.json")).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(state, "bridge-reports.json")).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(state, "bridge.json")).isDirectory()).toBe(true);
    for (const name of ["attention.json", "reply-suggestions.json", "seat-tick-settings.json"]) {
      expect(fs.lstatSync(path.join(state, name)).isDirectory()).toBe(true);
    }
  }, 30_000);

  /*
   * main's general guard for #1905 (`@/lib/stateOwnership`) asks a different
   * question than the barrier: whether the process declares an owner that may
   * run a startup mutation. Inside the serving container `LLV_STATE_OWNER` is
   * already set in the environment, so a `bun run build` run THERE answers
   * that question yes while still being the module load that took production
   * down. The barrier is checked first for exactly this process: it is a
   * declared owner, its activation gate is open, and it is still refused,
   * because a module load may never rename live state away.
   */
  test("a declared owner with an open gate writes nothing during a build either", async () => {
    const { root, state } = seededRoot();
    const before = snapshot(root);
    const run = await loadModules(root, { buildPhase: true, activated: true, owner: "viewer" });
    expect(run.exit).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(state, "state.sqlite"))).toBe(false);
    expect(fs.lstatSync(path.join(state, "claude-accounts.json")).isFile()).toBe(true);
  }, 30_000);

  test("an opened gate does not survive the build phase: the build still writes nothing", async () => {
    const { root, state } = seededRoot();
    const before = snapshot(root);
    const run = await loadModules(root, { buildPhase: true, activated: true });
    expect(run.exit).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(state, "state.sqlite"))).toBe(false);
  }, 30_000);
});

describe("a process that owns the release fence without serving traffic", () => {
  test("the deployment adapter's rollback mirrors are refused outside its own scope and written inside it", async () => {
    const { root, state } = seededRoot();
    const run = await loadModules(root, { buildPhase: false, activated: false, mode: "adapter-checkpoint" });
    expect(run.exit).toBe(0);
    expect(JSON.parse(run.out.trim()) as unknown).toEqual({
      refused: "StateMutationRefusedError",
      gateLeftOpen: false,
    });
    /* The rollback release finds its files where it left them. */
    expect(fs.lstatSync(path.join(state, "claude-accounts.json")).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(state, "account-project-bindings.json")).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(state, "attention.json")).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(state, "seat-tick-settings.json")).isFile()).toBe(true);
  }, 30_000);
});

describe("the barrier's own rules", () => {
  const configRoot = "/home/user/.config";
  const stateDirectory = path.join(configRoot, "agent-log-viewer", "state");
  const env = (extra: Record<string, string | undefined> = {}) => ({ XDG_CONFIG_HOME: configRoot, ...extra });

  test("a build phase is refused whatever else is true", () => {
    openStateMutationActivation();
    expect(stateMutationRefusal(stateDirectory, env({ NEXT_PHASE: "phase-production-build" }))).toContain("build");
    expect(stateMutationRefusal("/tmp/llv-somewhere", env({ NEXT_PHASE: "phase-production-build", LLV_STATE_DIR: "/tmp/llv-somewhere" })))
      .toContain("build");
  });

  test("a default state directory is refused until the activation opens the gate", () => {
    expect(stateMutationRefusal(stateDirectory, env())).toContain("serving Viewer");
    openStateMutationActivation();
    expect(stateMutationRefusal(stateDirectory, env())).toBeNull();
  });

  test("a state directory the caller named is its own to import", () => {
    expect(stateMutationRefusal("/tmp/llv-named/state", env({ LLV_STATE_DIR: "/tmp/llv-named/state" }))).toBeNull();
    expect(stateMutationRefusal("/tmp/llv-named/state", env())).toBeNull();
    /* LLV_STATE_DIR names one directory; it does not open the default one. */
    expect(stateMutationRefusal(stateDirectory, env({ LLV_STATE_DIR: "/tmp/llv-named/state" }))).toContain("serving Viewer");
  });

  /* The isolation #1905 prescribes is XDG_CONFIG_HOME=$(mktemp -d) with
     LLV_STATE_DIR=$XDG_CONFIG_HOME/state. That state dir sits inside its own
     config root, and a module that captured it before the process repointed
     LLV_STATE_DIR at a second sandbox must still be allowed to import it. */
  test("a state directory beside the app dir is the caller's own, not a default root", () => {
    const sandbox = path.join(configRoot, "state");
    expect(stateMutationRefusal(sandbox, env())).toBeNull();
    expect(stateMutationRefusal(sandbox, env({ LLV_STATE_DIR: "/tmp/llv-second-sandbox" }))).toBeNull();
    /* The incident's own directory, and the dir name it used before the
       rename, stay refused. */
    expect(stateMutationRefusal(stateDirectory, env())).toContain("serving Viewer");
    expect(stateMutationRefusal(path.join(configRoot, "live-log-viewer", "state"), env())).toContain("serving Viewer");
  });

  test("the legacy viewer-state directory counts as a default root", () => {
    const legacy = path.join(os.homedir(), ".claude", "viewer-state");
    expect(stateMutationRefusal(legacy, env())).toContain("serving Viewer");
  });

  test("every build phase name Next sets is a build phase", () => {
    expect(nextBuildPhase({ NEXT_PHASE: "phase-production-build" })).toBe(true);
    expect(nextBuildPhase({ NEXT_PHASE: "phase-export" })).toBe(false);
    expect(nextBuildPhase({})).toBe(false);
  });
});
