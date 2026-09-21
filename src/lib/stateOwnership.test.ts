import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRegistryBackend } from "@/lib/agent/registryBackendIdentity";

import {
  admitOperatorDirectory,
  assertStateStartupMutation,
  isOperatorOwnedDirectory,
  STATE_OWNER_ENV,
  underOperatorRoot,
} from "./stateOwnership";

/*
 * The mechanism behind #1905: a build, a test or a script can never touch the
 * operator's live state directory.
 *
 * The process-level cases run a probe in a child process, because the question
 * is what a process with a given environment resolves — and this runner has
 * pinned `LLV_STATE_DIR` for itself before the first module loaded.
 *
 * The probe's "operator home" is a directory inside `node_modules`: it must NOT
 * sit under a temp root, since a `$HOME` under one is exactly the sandbox the
 * mechanism leaves alone.
 */
const PROBE = path.join("src", "lib", "state", "fixtures", "stateOwnershipProbe.ts");
const OPERATOR_HOME = path.join(process.cwd(), "node_modules", ".llv-state-ownership-test", "home");
const STATE_DIRECTORY = path.join(OPERATOR_HOME, ".config", "agent-log-viewer", "state");
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-state-ownership-"));
  temporaryRoots.push(directory);
  return directory;
}

/** An operator installation with one legacy store in it: what the incident's
    build found, and what it imported out from under the running Viewer. */
function seedOperatorHome(): void {
  fs.rmSync(path.dirname(OPERATOR_HOME), { recursive: true, force: true });
  fs.mkdirSync(STATE_DIRECTORY, { recursive: true });
  fs.writeFileSync(
    path.join(STATE_DIRECTORY, "tasks.json"),
    JSON.stringify({
      tasks: [{
        id: "task-one",
        project: "repo-placeholder",
        status: "inbox",
        text: "live work",
        assignments: [],
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      }],
    }),
  );
}

/** Every path under `root`, with the bytes of each file, so a single
    comparison says whether anything at all was written. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      const key = path.relative(root, full);
      if (entry.isDirectory()) {
        entries[`${key}/`] = "";
        walk(full);
      } else {
        entries[key] = fs.readFileSync(full).toString("base64");
      }
    }
  };
  walk(root);
  return entries;
}

/** A minimal environment literal: this repository's `ProcessEnv` requires
    `NODE_ENV`, and none of these cases is about it. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", ...extra };
}

interface ProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runProbe(mode: "resolve" | "load-stores" | "open-registry" | "resolve-then-disown" | "resolve-then-chdir", environment: Record<string, string | undefined>): ProbeResult {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...environment })) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(environment)) if (value === undefined) delete env[key];
  const result = Bun.spawnSync({
    cmd: [process.execPath, PROBE, mode],
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** The environment of a process that inherited the operator's session and set
    nothing of its own — the state every one of these cases starts from. */
function operatorEnvironment(temporary: string): Record<string, string | undefined> {
  return {
    HOME: OPERATOR_HOME,
    XDG_CONFIG_HOME: path.join(OPERATOR_HOME, ".config"),
    TMPDIR: temporary,
    LLV_STATE_DIR: undefined,
    LLV_AGENT_REGISTRY_SQLITE: undefined,
    [STATE_OWNER_ENV]: undefined,
    NEXT_PHASE: undefined,
    NEXT_RUNTIME: undefined,
    NODE_ENV: "production",
  };
}

beforeEach(() => {
  seedOperatorHome();
});

afterAll(() => {
  fs.rmSync(path.dirname(OPERATOR_HOME), { recursive: true, force: true });
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe("the operator's state directory", () => {
  test("a production build that loads the instrumentation and a store writes nothing outside a temp dir", () => {
    const temporary = temporaryRoot();
    const before = snapshot(OPERATOR_HOME);

    const probe = runProbe("load-stores", {
      ...operatorEnvironment(temporary),
      NEXT_PHASE: "phase-production-build",
      NEXT_RUNTIME: "nodejs",
    });

    expect(probe.stderr + probe.stdout).not.toContain("Error:");
    expect(probe.status).toBe(0);
    const resolved = JSON.parse(probe.stdout.trim().split("\n").at(-1)!) as { stateDirectory: string };
    /* The store it read was a throw-away one under the temp root, so the
       first-boot import had nothing of the operator's to import. */
    expect(resolved.stateDirectory.startsWith(`${temporary}${path.sep}`)).toBeTrue();
    expect(snapshot(OPERATOR_HOME)).toEqual(before);
    expect(fs.existsSync(path.dirname(resolved.stateDirectory))).toBeFalse();
  });

  test("an MCP registry reader leaves operator-owned legacy cleanup for the release fence", () => {
    const temporary = temporaryRoot();
    const registryDirectory = path.join(STATE_DIRECTORY);
    const mirror = path.join(registryDirectory, "agent-registry.json");
    const staleTemporary = path.join(registryDirectory, "agent-registry.json.4242.00000000-0000-0000-0000-000000000000.tmp");
    const sqlite = path.join(registryDirectory, "agent-registry.sqlite");
    fs.writeFileSync(mirror, JSON.stringify({ version: 2, entries: {}, receipts: {}, conversations: {} }));
    fs.writeFileSync(staleTemporary, "stale");
    fs.writeFileSync(sqlite, "");
    fs.writeFileSync(path.join(registryDirectory, "agent-registry.backend.json"), JSON.stringify({
      schemaVersion: 1,
      mode: "sqlite",
      sqliteFile: path.basename(sqlite),
      publishedAt: "2026-09-20T00:00:00.000Z",
    }));

    const probe = runProbe("open-registry", {
      ...operatorEnvironment(temporary),
      [STATE_OWNER_ENV]: "mcp",
    });

    expect(probe.status).toBe(0);
    expect(fs.existsSync(mirror)).toBeTrue();
    expect(fs.existsSync(staleTemporary)).toBeTrue();
  });

  test("a script without the opt-in cannot resolve it, while the launcher and the deploy adapter can", () => {
    const temporary = temporaryRoot();

    const script = runProbe("resolve", operatorEnvironment(temporary));
    expect(script.status).not.toBe(0);
    expect(script.stderr).toContain(STATE_OWNER_ENV);
    expect(script.stdout.trim()).toBe("");

    for (const owner of ["launcher", "deploy-adapter", "viewer", "runtime-host"]) {
      const owned = runProbe("resolve", { ...operatorEnvironment(temporary), [STATE_OWNER_ENV]: owner });
      expect(owned.status).toBe(0);
      const resolved = JSON.parse(owned.stdout.trim()) as { stateDirectory: string };
      expect(path.resolve(resolved.stateDirectory)).toBe(path.resolve(STATE_DIRECTORY));
    }
  });

  test("a resolved state directory is decided again when the owner changes, never remembered past it (#1987)", () => {
    const temporary = temporaryRoot();
    const probe = runProbe("resolve-then-disown", { ...operatorEnvironment(temporary), [STATE_OWNER_ENV]: "viewer" });
    expect(probe.status).toBe(0);
    const resolved = JSON.parse(probe.stdout.trim()) as { stateDirectory: string; afterDisown: string };
    expect(path.resolve(resolved.stateDirectory)).toBe(path.resolve(STATE_DIRECTORY));
    expect(resolved.afterDisown).toBe("refused: UnownedStateAccessError");
  });

  test("a relative config root is decided again after the working directory changes (#1987)", () => {
    const temporary = temporaryRoot();
    const probe = runProbe("resolve-then-chdir", {
      ...operatorEnvironment(temporary),
      XDG_CONFIG_HOME: ".config",
      /* Observation-worker mode runs no legacy migration: only the admission
         is exercised, and nothing is written anywhere. */
      LLV_RESOURCE_OBSERVATION_WORKER: "1",
      PROBE_FIRST_CWD: temporary,
      PROBE_SECOND_CWD: OPERATOR_HOME,
    });
    expect(probe.status).toBe(0);
    const resolved = JSON.parse(probe.stdout.trim()) as { stateDirectory: string; afterChdir: string };
    expect(resolved.stateDirectory).toBe(path.resolve(temporary, ".config", "agent-log-viewer", "state"));
    expect(resolved.afterChdir).toBe("refused: UnownedStateAccessError");
  });

  test("an owner that holds no release fence still runs no startup mutation", () => {
    const temporary = temporaryRoot();

    /* The launcher reads the operator's state, and reads it where it lives. */
    expect(admitOperatorDirectory(STATE_DIRECTORY, "state", env({
      HOME: OPERATOR_HOME,
      [STATE_OWNER_ENV]: "launcher",
    }))).toBe(STATE_DIRECTORY);

    expect(() => assertStateStartupMutation(STATE_DIRECTORY, "tasks import", env({
      HOME: OPERATOR_HOME,
      [STATE_OWNER_ENV]: "launcher",
    }))).toThrow("tasks import");

    for (const owner of ["viewer", "runtime-host"]) {
      expect(() => assertStateStartupMutation(STATE_DIRECTORY, "tasks import", env({
        HOME: OPERATOR_HOME,
        [STATE_OWNER_ENV]: owner,
      }))).not.toThrow();
    }

    /* A sandbox is nobody's to fence: this is how every test drives an import. */
    expect(() => assertStateStartupMutation(path.join(temporary, "state"), "tasks import", env())).not.toThrow();
  });

  test("a directory the caller chose is admitted untouched", () => {
    const temporary = temporaryRoot();
    const chosen = path.join(temporary, "state");
    expect(isOperatorOwnedDirectory(chosen, env({ HOME: OPERATOR_HOME }))).toBeFalse();
    expect(admitOperatorDirectory(chosen, "state", env())).toBe(chosen);
    /* A `$HOME` under the temp root is a sandbox, not the operator's home. */
    expect(isOperatorOwnedDirectory(
      path.join(temporary, "home", ".config", "agent-log-viewer", "state"),
      env({ HOME: path.join(temporary, "home") }),
    )).toBeFalse();
  });

  test("a scratch root inside it is still a scratch root", () => {
    /* A restricted stage agent is handed `TMPDIR` under `statePath("scratch")`,
       so by containment alone every directory it mktemps reads as the
       operator's — and the suites it runs, which drive imports and backups
       against their own temp directories, were refused. */
    const scratch = path.join(STATE_DIRECTORY, "scratch", "llv-read-only-stage-a1b2c3", "tmp");
    const environment = env({ HOME: OPERATOR_HOME, TMPDIR: scratch });
    const mkdtemped = path.join(scratch, "llv-durability-a1b2c3");

    expect(underOperatorRoot(scratch, environment)).toBeTrue();
    expect(isOperatorOwnedDirectory(scratch, environment)).toBeFalse();
    expect(isOperatorOwnedDirectory(mkdtemped, environment)).toBeFalse();
    expect(() => assertStateStartupMutation(mkdtemped, "state backup pass", environment)).not.toThrow();

    /* The exemption reaches exactly as far as the scratch root: the state
       directory around it is the operator's, as it was. */
    expect(isOperatorOwnedDirectory(STATE_DIRECTORY, environment)).toBeTrue();
    expect(() => assertStateStartupMutation(STATE_DIRECTORY, "state backup pass", environment)).toThrow();
  });

  test("a build whose temp root was deleted under it still gets a throw-away directory", () => {
    /* The restricted stage's scratch — and with it the `TMPDIR` every child
       inherited — is removed when the stage releases. A substitution that
       cannot create its root would turn a harmless one into an ENOENT crash. */
    const temporary = temporaryRoot();
    fs.rmSync(temporary, { recursive: true, force: true });

    const probe = runProbe("resolve", {
      ...operatorEnvironment(temporary),
      NEXT_PHASE: "phase-production-build",
    });

    expect(probe.stderr).not.toContain("ENOENT");
    expect(probe.status).toBe(0);
    const resolved = JSON.parse(probe.stdout.trim()) as { stateDirectory: string };
    expect(resolved.stateDirectory.startsWith(`${temporary}${path.sep}`)).toBeTrue();
  });

  test("a fresh install's first registry open is no migration at all", () => {
    /* `AgentRegistry` asserts the startup mutation only on the path that
       retires an authoritative JSON, and that path is taken only when the
       backend resolution reports one. The deliberate consequence of the
       assert is therefore bounded: an install with an authoritative
       agents.json refuses a non-fence opener (a Viewer boot clears it), while
       an install with nothing to import initialises as it always did. */
    const temporary = temporaryRoot();
    const registry = path.join(temporary, "agent-registry.json");

    expect(resolveRegistryBackend(registry, env()).pendingJsonImport).toBeFalse();

    fs.writeFileSync(registry, JSON.stringify({ conversations: [] }));
    expect(resolveRegistryBackend(registry, env()).pendingJsonImport).toBeTrue();
  });
});
