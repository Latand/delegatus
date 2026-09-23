import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import * as fsNamespace from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-configdir-test-"));
const REAL_XDG = process.env.XDG_CONFIG_HOME;
const REAL_CACHE = process.env.XDG_CACHE_HOME;
const REAL_STATE = process.env.LLV_STATE_DIR;

const { cacheEntryPath, configFilePath, inboxDir, migrateLegacyDir, resetAppDirForTests, stateDir, statePath } = await import("./configDir");
const { closeStateMutationActivationForTests, openStateMutationActivation } = await import("@/lib/state/stateMutationBarrier");
const { appDirIn, resetAppDirWarningsForTests } = await import("../../bin/appDir.mjs");

afterAll(() => {
  if (REAL_XDG !== undefined) process.env.XDG_CONFIG_HOME = REAL_XDG;
  else delete process.env.XDG_CONFIG_HOME;
  if (REAL_CACHE !== undefined) process.env.XDG_CACHE_HOME = REAL_CACHE;
  else delete process.env.XDG_CACHE_HOME;
  if (REAL_STATE !== undefined) process.env.LLV_STATE_DIR = REAL_STATE;
  else delete process.env.LLV_STATE_DIR;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("LLV_STATE_DIR overrides the state dir wholesale", () => {
  process.env.LLV_STATE_DIR = path.join(SANDBOX, "custom-state");
  expect(stateDir()).toBe(path.join(SANDBOX, "custom-state"));
  expect(statePath("flows", "artifact.md")).toBe(path.join(SANDBOX, "custom-state", "flows", "artifact.md"));
  delete process.env.LLV_STATE_DIR;
});

test("state and inbox of an existing install live under the agent-log-viewer config dir", () => {
  const xdg = path.join(SANDBOX, "xdg");
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.LLV_STATE_DIR;
  /* Pre-settled targets (sentinel planted): the resolution is under test
     here, and a settled dir keeps the migration from touching the machine's
     real legacy state. */
  for (const name of ["state", "inbox"]) {
    fs.mkdirSync(path.join(xdg, "agent-log-viewer", name), { recursive: true });
    fs.writeFileSync(path.join(xdg, "agent-log-viewer", name, ".migrated-from-legacy"), "test\n");
  }
  expect(stateDir()).toBe(path.join(xdg, "agent-log-viewer", "state"));
  expect(inboxDir()).toBe(path.join(xdg, "agent-log-viewer", "inbox"));
});

test("legacy config and cache paths remain active when the current entries are absent", () => {
  const configRoot = path.join(SANDBOX, "legacy-paths-config");
  const cacheRoot = path.join(SANDBOX, "legacy-paths-cache");
  process.env.XDG_CONFIG_HOME = configRoot;
  process.env.XDG_CACHE_HOME = cacheRoot;
  const legacyConfig = path.join(configRoot, "live-log-viewer", "transcribe-backend");
  const legacyCache = path.join(cacheRoot, "live-log-viewer", "whisper-venv");
  fs.mkdirSync(path.dirname(legacyConfig), { recursive: true });
  fs.mkdirSync(legacyCache, { recursive: true });
  fs.writeFileSync(legacyConfig, "local\n");

  expect(configFilePath("transcribe-backend")).toBe(legacyConfig);
  expect(cacheEntryPath("whisper-venv")).toBe(legacyCache);
  fs.writeFileSync(configFilePath("transcribe-backend"), "chatgpt\n");
  expect(fs.readFileSync(legacyConfig, "utf8")).toBe("chatgpt\n");
});

test("migration copies the legacy tree once, marks completion, leaves the source in place", () => {
  const legacy = path.join(SANDBOX, "legacy-state");
  const target = path.join(SANDBOX, "new-state");
  fs.mkdirSync(path.join(legacy, "flows"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "flows.json"), '{"flows":[]}');
  fs.writeFileSync(path.join(legacy, "flows", "artifact.md"), "round");

  migrateLegacyDir(target, legacy);
  expect(fs.readFileSync(path.join(target, "flows.json"), "utf8")).toBe('{"flows":[]}');
  expect(fs.readFileSync(path.join(target, "flows", "artifact.md"), "utf8")).toBe("round");
  expect(fs.existsSync(path.join(target, ".migrated-from-legacy"))).toBe(true);
  expect(fs.existsSync(path.join(legacy, "flows.json"))).toBe(true);
  /* No leftover temp dirs from the atomic copy. */
  expect(fs.readdirSync(SANDBOX).filter((name) => name.includes(".migrating."))).toEqual([]);
});

test("existing target files are never overwritten; missing legacy entries heal in", () => {
  const legacy = path.join(SANDBOX, "legacy-2");
  const target = path.join(SANDBOX, "target-2");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "flows.json"), "OLD");
  fs.writeFileSync(path.join(legacy, "tasks.json"), "LEGACY-TASKS");
  /* The partial-migration shape: state writes created the target and one
     file, no sentinel — an interrupted pre-sentinel run looked exactly so. */
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "flows.json"), "NEW");

  migrateLegacyDir(target, legacy);
  expect(fs.readFileSync(path.join(target, "flows.json"), "utf8")).toBe("NEW");
  expect(fs.readFileSync(path.join(target, "tasks.json"), "utf8")).toBe("LEGACY-TASKS");
  expect(fs.existsSync(path.join(target, ".migrated-from-legacy"))).toBe(true);
});

test("a missing legacy dir marks the fresh target as settled", () => {
  const target = path.join(SANDBOX, "target-3");
  migrateLegacyDir(target, path.join(SANDBOX, "no-such-legacy"));
  expect(fs.existsSync(path.join(target, ".migrated-from-legacy"))).toBe(true);
});

test("a failed copy leaves no target and the next attempt succeeds", () => {
  const legacy = path.join(SANDBOX, "legacy-4");
  const target = path.join(SANDBOX, "target-4");
  const locked = path.join(legacy, "locked");
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, "secret.json"), "data");
  fs.writeFileSync(path.join(legacy, "flows.json"), "FLOWS");
  fs.chmodSync(locked, 0o000); // unreadable subdir makes cpSync throw mid-tree
  try {
    migrateLegacyDir(target, legacy);
    /* The atomic rename never ran: no half-filled target, no temp leftovers,
       and the failure stayed un-memoized. */
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(SANDBOX).filter((name) => name.startsWith("target-4.migrating"))).toEqual([]);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  migrateLegacyDir(target, legacy);
  expect(fs.readFileSync(path.join(target, "flows.json"), "utf8")).toBe("FLOWS");
  expect(fs.readFileSync(path.join(target, "locked", "secret.json"), "utf8")).toBe("data");
  expect(fs.existsSync(path.join(target, ".migrated-from-legacy"))).toBe(true);
});

test("a completed migration never reruns even when new files land in legacy", () => {
  const legacy = path.join(SANDBOX, "legacy-5");
  const target = path.join(SANDBOX, "target-5");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "flows.json"), "V1");
  migrateLegacyDir(target, legacy);
  fs.writeFileSync(path.join(legacy, "late.json"), "LATE");
  migrateLegacyDir(target, legacy);
  expect(fs.existsSync(path.join(target, "late.json"))).toBe(false);
});

/* ── The Delegatus app dir (rename-delegatus.md §4.2) ─────────────────────── */

/** A config root holding an install from before the rename: its state dir,
    settled, and a transcript mirrored into `shared/` the way account homes
    record it. */
function existingInstall(name: string): { root: string; recorded: string } {
  const root = path.join(SANDBOX, name);
  const state = path.join(root, "agent-log-viewer", "state");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, ".migrated-from-legacy"), "test\n");
  const recorded = path.join(root, "agent-log-viewer", "shared", "claude", "projects", "widgets", "session.jsonl");
  fs.mkdirSync(path.dirname(recorded), { recursive: true });
  fs.writeFileSync(recorded, "{}\n");
  return { root, recorded };
}

function useConfigRoot(root: string): void {
  process.env.XDG_CONFIG_HOME = root;
  delete process.env.LLV_STATE_DIR;
  resetAppDirForTests();
}

test("a fresh home resolves ~/.config/delegatus, and its first write makes it a real directory", () => {
  const root = path.join(SANDBOX, "fresh-home-config");
  useConfigRoot(root);
  expect(stateDir()).toBe(path.join(root, "delegatus", "state"));
  expect(inboxDir()).toBe(path.join(root, "delegatus", "inbox"));
  fs.mkdirSync(stateDir(), { recursive: true });
  const stat = fs.lstatSync(path.join(root, "delegatus"));
  expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
  expect(fs.existsSync(path.join(root, "agent-log-viewer"))).toBe(false);
});

test("an existing home keeps its spelling, gains the link, and a recorded transcript path still matches", () => {
  const { root, recorded } = existingInstall("existing-home-config");
  useConfigRoot(root);
  openStateMutationActivation();
  try {
    /* The Viewer after its activation: the only process that makes the link. */
    expect(stateDir()).toBe(path.join(root, "agent-log-viewer", "state"));
  } finally {
    closeStateMutationActivationForTests();
  }
  const link = path.join(root, "delegatus");
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(link)).toBe("agent-log-viewer");

  /* Nothing moved: the recorded path is still what the resolver builds and
     what realpath answers, including for the same file reached by the new
     name. Registry lookups compare these strings. */
  resetAppDirForTests();
  expect(stateDir()).toBe(path.join(root, "agent-log-viewer", "state"));
  const scanned = path.join(path.dirname(stateDir()), "shared", "claude", "projects", "widgets", "session.jsonl");
  expect(scanned).toBe(recorded);
  expect(fs.realpathSync(recorded)).toBe(fs.realpathSync(root) + recorded.slice(root.length));
  expect(fs.realpathSync(path.join(link, "shared", "claude", "projects", "widgets", "session.jsonl"))).toBe(fs.realpathSync(recorded));
});

test("two real app dirs: delegatus wins, with one warning naming both", () => {
  const root = path.join(SANDBOX, "two-installs-config");
  fs.mkdirSync(path.join(root, "delegatus"), { recursive: true });
  fs.mkdirSync(path.join(root, "agent-log-viewer"), { recursive: true });
  useConfigRoot(root);
  resetAppDirWarningsForTests();
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    expect(appDirIn(root)).toBe(path.join(root, "delegatus"));
    expect(appDirIn(root)).toBe(path.join(root, "delegatus"));
    expect(stateDir()).toBe(path.join(root, "delegatus", "state"));
  } finally {
    console.warn = warn;
  }
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(path.join(root, "delegatus"));
  expect(warnings[0]).toContain(path.join(root, "agent-log-viewer"));
});

test("a temp-root XDG_CONFIG_HOME is left untouched by anything but the activated Viewer", () => {
  const { root } = existingInstall("untouched-temp-config");
  useConfigRoot(root);
  expect(stateDir()).toBe(path.join(root, "agent-log-viewer", "state"));
  statePath("tasks.json");
  expect(fs.existsSync(path.join(root, "delegatus"))).toBe(false);
});

test("a next build phase is refused the link step", () => {
  const { root } = existingInstall("build-phase-config");
  useConfigRoot(root);
  const phase = process.env.NEXT_PHASE;
  process.env.NEXT_PHASE = "phase-production-build";
  openStateMutationActivation();
  try {
    expect(stateDir()).toBe(path.join(root, "agent-log-viewer", "state"));
  } finally {
    closeStateMutationActivationForTests();
    if (phase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = phase;
  }
  expect(fs.existsSync(path.join(root, "delegatus"))).toBe(false);
});

test("a process that may not make the link pays no lstat per statePath() after the first (#1987)", () => {
  /* An existing install with no link yet, read by a process the barrier
     refuses (no Viewer activation): the link stays pending for it, so its
     check must cost nothing on the hot path. */
  const { root } = existingInstall("no-owner-hot-path-config");
  useConfigRoot(root);
  expect(stateDir()).toBe(path.join(root, "agent-log-viewer", "state"));
  const lstat = spyOn(fsNamespace, "lstatSync");
  try {
    for (let call = 0; call < 5; call += 1) statePath("tasks.json");
    expect(lstat).toHaveBeenCalledTimes(0);
  } finally {
    lstat.mockRestore();
  }
  expect(fs.existsSync(path.join(root, "delegatus"))).toBe(false);
});
