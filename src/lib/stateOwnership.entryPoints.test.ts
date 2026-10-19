import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { OWNERSHIP_PRELOAD, ownershipSandbox } from "./state/fixtures/ownershipSandbox";

/*
 * The other half of #1905: the processes that DO own the operator's state have
 * to keep reaching it.
 *
 * `stateOwnership.test.ts` drives a probe fixture whose module graph is two
 * dynamic imports deep, so it could not see the defect that shipped in the
 * first round of this change: an owner claim written in an entry point's body
 * runs after every module that entry imports, and several of those modules
 * resolve the state directory while they load. Every case here starts a REAL
 * entry point, under an operator-shaped home, with nothing preset in the
 * environment — which is how the Viewer MCP server and two operator scripts
 * were found dead on arrival.
 *
 * Platform paths are injected in the runner and each child, so the operator
 * home is a private fixture even when this checkout lives under a temp root.
 */
const sandbox = ownershipSandbox();
const OPERATOR_HOME = sandbox.home;
/* Both shapes an operator's home takes after the rename (rename-delegatus.md
   §4.2): a new install holds only `~/.config/delegatus`, an existing one only
   `~/.config/agent-log-viewer`. */
const APP_DIRS = ["delegatus", "agent-log-viewer"] as const;
const MCP_BUNDLE = path.join(process.cwd(), "dist", "mcp-server.mjs");
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const directory = sandbox.temporaryRoot();
  temporaryRoots.push(directory);
  return directory;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

/**
 * Start `command` the way an operator's shell would: their home, their config
 * root, and not one of this mechanism's variables set. `NODE_ENV` is pinned to
 * production because the runner exports `test`, which would hand the child a
 * throw-away directory and answer a different question than the one asked.
 */
function operatorEnvironment(): Record<string, string> {
  const env = sandbox.environment();
  env.TMPDIR = temporaryRoot();
  env.NODE_ENV = "production";
  return env;
}

function runEntryPoint(command: string[], env: Record<string, string | undefined> = operatorEnvironment()): RunResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--preload", OWNERSHIP_PRELOAD, ...command],
    cwd: process.cwd(),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  return { status: result.exitCode, stdout, stderr, output: stdout + stderr };
}

/** The refusal every case here exists to rule out. */
function expectNoRefusal(result: RunResult): void {
  expect(result.output).not.toContain("refusing to resolve the operator's state directory");
  expect(result.output).not.toContain("UnownedStateAccessError");
  expect(result.output).not.toContain("StateStartupMutationRefused");
}

beforeAll(() => {
  /* The bundle is what Claude actually launches on a deployed install, and a
     bundler is free to reorder what a source file makes explicit — so the
     claim is proved in the artifact, not only in the source. */
  const built = Bun.spawnSync({
    cmd: [process.execPath, "scripts/build-mcp.ts"],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (built.exitCode !== 0) throw new Error(`scripts/build-mcp.ts failed: ${built.stderr.toString()}`);
});

afterAll(() => {
  fs.rmSync(OPERATOR_HOME, { recursive: true, force: true });
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
  sandbox.release();
});

for (const appDir of APP_DIRS) describe(`an entry point that owns the operator's state, under a home holding only ~/.config/${appDir}`, () => {
  const STATE_DIRECTORY = path.join(OPERATOR_HOME, ".config", appDir, "state");
  const OTHER_APP_DIR = path.join(OPERATOR_HOME, ".config", APP_DIRS.find((name) => name !== appDir)!);

  beforeEach(() => {
    fs.rmSync(OPERATOR_HOME, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIRECTORY, { recursive: true });
  });

  for (const [label, command] of [
    ["the source entry", ["src/lib/mcp/entry.ts"]],
    ["the published bundle", [MCP_BUNDLE]],
  ] as const) {
    test.skipIf(process.platform !== "linux")(`native hook mode in ${label} claims state before importing its graph`, () => {
      const result = runEntryPoint([...command, "--native-caller-hook"]);
      expectNoRefusal(result);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("native caller hook needs its Claude parent");
    });
    test(`the Viewer MCP server starts from ${label} with its state claim and a stateless Linux transport`, () => {
      const result = runEntryPoint([...command]);

      expectNoRefusal(result);
      /* A server that reached its transport exits 0 when stdin is already at
         EOF. Getting that far means the whole graph loaded — including
         `src/lib/inbox.ts`, which resolves the operator's inbox at module
         scope and is where the late claim threw. */
      expect(result.status).toBe(0);
      /* The bundle contains the GitHub App helper, whose command line entry
         belongs to the helper's own file: started as the MCP server it must
         not read this process's arguments as a credential request. */
      expect(result.stderr).not.toContain("token|gh|git-credential");
      /* Adapters forward before constructing the local receipt store. */
      expect(fs.existsSync(path.join(STATE_DIRECTORY, "mcp-receipts.sqlite"))).toBe(false);
      /* An MCP server is no startup-mutation owner: it neither creates the
         other name nor makes the link. */
      expect(fs.existsSync(OTHER_APP_DIR)).toBeFalse();
    }, 60_000);
  }

  /* Each script is given the arguments that make it answer fastest; reaching
     its own parsing at all is the assertion, because the failure this guards
     is a throw during module evaluation, before any argument is read. */
  for (const [script, argv, marker] of [
    ["scripts/relay-switch.ts", ["status"], "chain_conversations"],
    ["scripts/rollback-runtime-host.ts", [], "no retained runtime-host rollback target"],
    ["scripts/cutover-shared-claude-projects.ts", [], "nothing to cut over"],
    ["scripts/migrate-legacy-tmux.ts", [], "only `preflight --root <transcript>`"],
    ["scripts/runtime-host-viewer-adapter.ts", [], "deployment adapter protocol is required"],
    ["scripts/bootstrap-runtime-host.ts", ["--not-a-mode"], "unsupported option --not-a-mode"],
    ["scripts/export-human-input.ts", [], "--host is required"],
    ["scripts/rebuild-http.ts", [], "Deployment HTTP request failed"],
  ] as const) {
    test(`${script} reaches its own body`, () => {
      const result = runEntryPoint([script, ...argv]);

      expectNoRefusal(result);
      expect(result.output).toContain(marker);
    }, 60_000);
  }

  test("the runtime host starts and keeps its journal in the operator's state directory", async () => {
    /* A long-lived server, so it is started, observed listening and stopped
       by its own handle. Its socket sits under the temp root because one
       under this home is longer than `sun_path` allows; deployments stay off
       so no stable port is bound, and the Viewer control URL is a closed
       port. */
    const socketPath = path.join(temporaryRoot(), "runtime-host.sock");
    const child = Bun.spawn({
      cmd: [process.execPath, "--preload", OWNERSHIP_PRELOAD, "src/runtime-host/main.ts"],
      cwd: process.cwd(),
      env: { ...operatorEnvironment(), LLV_RUNTIME_HOST_SOCKET: socketPath, LLV_VIEWER_DEPLOYMENTS: "0", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const connects = () => new Promise<boolean>((resolve) => {
      const socket = net.createConnection(socketPath);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    let listening = false;
    try {
      const deadline = Date.now() + 30_000;
      while (child.exitCode === null && Date.now() < deadline) {
        if (await connects()) { listening = true; break; }
        await Bun.sleep(50);
      }
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      if (!await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)])) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
    const result = { status: child.exitCode, stdout: await stdout, stderr: await stderr, output: "" };
    result.output = result.stdout + result.stderr;

    expectNoRefusal(result);
    expect(listening, result.output).toBeTrue();
    expect(fs.existsSync(path.join(STATE_DIRECTORY, "runtime-events.sqlite"))).toBeTrue();
  }, 60_000);

  test("the launcher runs under the operator's home", () => {
    /* `--help` resolves no state today, so this case says only that the
       launcher entry itself is not refused while loading — which is exactly
       what the entries above stopped being able to say. */
    const result = runEntryPoint(["bin/cli.mjs", "--help"]);

    expectNoRefusal(result);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: delegatus");
  }, 60_000);

  test("a process that declares no owner is still refused", () => {
    /* The guard is what all of the above run against: with the same
       environment and no claim anywhere in the entry point, the refusal
       stands. */
    const result = runEntryPoint(["src/lib/state/fixtures/stateOwnershipProbe.ts"]);

    expect(result.status, result.output).not.toBe(0);
    expect(result.stderr).toContain("refusing to resolve the operator's state directory");
  }, 60_000);
});
