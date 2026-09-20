import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  admitOperatorDirectory,
  assertStateStartupMutation,
  isOperatorOwnedDirectory,
  STATE_OWNER_ENV,
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

function runProbe(mode: "resolve" | "load-stores", environment: Record<string, string | undefined>): ProbeResult {
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
});
