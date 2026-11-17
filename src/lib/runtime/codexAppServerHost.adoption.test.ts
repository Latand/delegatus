// destructive-code: head-only; fixture-owned paths and recording process doubles.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { procBackend } from "@/lib/proc";
import { CodexAppServerHost } from "./codexAppServerHost";
import { FileRuntimeEventStore } from "./eventStore";
import { adoptCodexRegistryHosts, bindCodexHostPersistence } from "./registry";
import { installCodexHostFixture, MemoryEventStore, FakeAppServer, fakeSpawn, waitForCondition, ownedFakeProcess } from "./codexAppServerHost.fixture";

installCodexHostFixture();

describe("CodexAppServerHost", () => {
  test("boot re-host resumes Codex and reconstructs its Viewer MCP connector (#1346)", async () => {
    const stdioEnv = { ...process.env, LLV_SPAWN_CAPABILITY: undefined };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-adoption-"));
    const registryPath = path.join(directory, "agent-registry.json");
    const registry = new AgentRegistry(registryPath);
    const key = { engine: "codex" as const, sessionId: "adopted-thread" };
    registry.upsert({
      key,
      artifactPath: "/sessions/adopted-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:old",
        process: null,
        eventCursor: 12,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 3,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 3,
      claimOwner: null,
      pendingAction: null,
    });
    const disabled = await adoptCodexRegistryHosts(
      registry,
      () => ({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(new FakeAppServer("adopted-thread")) }),
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "0" },
    );
    expect(disabled).toEqual([]);

    const server = new FakeAppServer("adopted-thread");
    const eventStore = new MemoryEventStore();
    const adopted = await adoptCodexRegistryHosts(
      registry,
      () => ({ cwd: "/repo", env: stdioEnv, eventStore, spawnProcess: fakeSpawn(server) }),
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );
    expect(adopted).toHaveLength(1);
    expect(server.requests.find((request) => request.method === "thread/resume")?.params).toMatchObject({
      config: {
        mcp_servers: {
          viewer: {
            command: "bun",
            args: [expect.stringContaining("bin/mcp-server.mjs")],
            enabled: true,
          },
        },
      },
    });
    expect(registry.snapshot().entries["codex:adopted-thread"]?.structuredHost).toMatchObject({
      eventCursor: 13,
      writerClaimEpoch: 4,
      endpoint: "stdio:4242",
    });
    const receipt = await adopted[0]!.host.send({ id: "persist-turn", text: "start" });
    expect(receipt.outcome).toBe("turn-started");
    const persistedTurn = registry.snapshot().entries["codex:adopted-thread"]?.structuredHost;
    expect(persistedTurn).toMatchObject({
      activeTurnRef: "turn-1",
    });
    // A following cursor event can coalesce with the turn's material write.
    expect(persistedTurn!.eventCursor).toBeGreaterThanOrEqual(14);
    expect(persistedTurn!.eventCursor).toBeLessThanOrEqual((await adopted[0]!.host.health()).eventCursor);
    expect(eventStore.load("adopted-thread").at(-1)?.seq).toBe(15);
    server.request("persist-attention", "item/commandExecution/requestApproval", { command: "date" });
    await Bun.sleep(0);
    expect(registry.snapshot().entries["codex:adopted-thread"]?.structuredHost?.pendingAttention).toEqual([
      expect.stringContaining("item/commandExecution/requestApproval:persist-attention:"),
    ]);
    await adopted[0]!.host.answer((await adopted[0]!.host.health()).pendingAttention[0]!, { decision: "decline" });
    expect(registry.snapshot().entries["codex:adopted-thread"]?.structuredHost?.pendingAttention).toEqual([]);
    await adopted[0]!.host.release();
    expect(registry.snapshot().entries["codex:adopted-thread"]).toMatchObject({
      status: "unhosted",
      claimOwner: null,
      structuredHost: { eventCursor: 19, process: null, activeTurnRef: null, pendingAttention: [] },
    });
    const restartedRegistry = new AgentRegistry(registryPath);
    const replacement = new FakeAppServer("adopted-thread");
    const releasedRows = await adoptCodexRegistryHosts(
      restartedRegistry,
      () => ({ cwd: "/repo", env: stdioEnv, eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(replacement) }),
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );
    expect(releasedRows).toHaveLength(1);
    expect(replacement.requests.some((request) => request.method === "thread/resume")).toBeTrue();
    expect(restartedRegistry.snapshot().entries["codex:adopted-thread"]).toMatchObject({
      status: "idle",
      host: null,
      claimEpoch: 5,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:4242",
        writerClaimEpoch: 5,
      },
    });
    await releasedRows[0]!.host.release();
  });

  test.each(["launcher", "source"] as const)("a severed seat re-hosts in a distinct process with a discoverable working Viewer MCP (%s)", async entry => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-successor-process-"));
    const home = path.join(directory, "home");
    const configHome = path.join(directory, "config");
    const stateDirectory = path.join(directory, "state");
    const tempDirectory = path.join(directory, "tmp");
    const targetPath = path.join(stateDirectory, "viewer-release.json");
    const transcriptPath = path.join(directory, "seat-successor.jsonl");
    const registryPath = path.join(directory, "agent-registry.json");
    const eventsPath = path.join(directory, "events");
    const mcpProofPath = path.join(directory, "viewer-mcp-proof.json");
    const incumbentReadyPath = path.join(directory, "incumbent-ready.json");
    const successorReadyPath = path.join(directory, "successor-ready.json");
    for (const pathname of [home, configHome, stateDirectory, tempDirectory]) {
      fs.mkdirSync(pathname, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(transcriptPath, "");
    const deployment = {
      deploymentId: "deployment_seat_successor",
      phase: "succeeded",
      revision: "e".repeat(8),
    };
    let controlRequests = 0;
    const control = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        controlRequests += 1;
        const url = new URL(request.url);
        // A retained launcher bundle can still use the deployment read API;
        // the current stdio adapter forwards the MCP request to the Viewer.
        if (url.pathname === "/api/mcp") {
          expect(request.method).toBe("POST");
          const call = await request.json() as { id: string; method: string; params: { name: string; arguments: { clientRequestId: string } } };
          expect(call.method).toBe("tools/call");
          expect(call.params.name).toBe("deployment_status");
          expect(call.params.arguments.clientRequestId).toBe("seat-successor-deployment-status");
          const result = { ok: true, toolName: "deployment_status", clientRequestId: call.params.arguments.clientRequestId,
            replayed: false, count: 1, deployments: [deployment] };
          return Response.json({ jsonrpc: "2.0", id: call.id, result: {
            content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result,
          } });
        }
        expect(entry).toBe("launcher");
        expect(request.method).toBe("GET");
        expect(url.pathname).toBe("/api/runtime/deployments");
        expect(url.searchParams.get("limit")).toBe("25");
        return Response.json({ count: 1, deployments: [deployment] });
      },
    });
    if (control.port === 8898) {
      control.stop(true);
      throw new Error("the seat-successor fixture selected the production port");
    }
    fs.writeFileSync(targetPath, JSON.stringify({
      revision: "e".repeat(40),
      image: "viewer:fixture",
      container: "viewer-fixture",
      endpoint: control.url.origin,
    }));
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_CACHE_HOME: path.join(directory, "cache"),
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_STATE_HOME: path.join(directory, "xdg-state"),
      TMPDIR: tempDirectory,
      LLV_STATE_DIR: stateDirectory,
      LLV_VIEWER_DEPLOY_TARGET: targetPath,
      LLV_VIEWER_PORT: String(control.port),
      ...(entry === "source" ? { LLV_SEAT_SUCCESSOR_MCP_ENTRY: path.resolve("src/lib/mcp/entry.ts") } : {}),
    };
    const hostFixture = path.join(import.meta.dir, "fixtures", "seatSuccessorHost.ts");
    type FixtureIdentity = { pid: number; startIdentity: string };
    type FixtureReady = {
      mode: "incumbent" | "successor";
      sessionId: string;
      viewer: FixtureIdentity;
      engine: FixtureIdentity;
      eventCursor: number;
      activeTurnRef: string | null;
      proof?: {
        enginePid: number;
        entry: string;
        toolNames?: string[];
        structuredContent?: unknown;
        error?: string;
      };
    };
    type FixtureFailure = { mode?: "incumbent" | "successor"; error: string };
    type FixtureHostProcess = ChildProcessWithoutNullStreams & { pid: number };
    const launchHost = (mode: "incumbent" | "successor", readyPath: string): FixtureHostProcess => {
      const child = spawn(process.execPath,
        [hostFixture, mode, registryPath, eventsPath, transcriptPath, mcpProofPath, readyPath], {
          cwd: process.cwd(),
          env: environment,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      if (!child.pid) {
        child.kill("SIGKILL");
        throw new Error("fixture host process has no pid");
      }
      return child as FixtureHostProcess;
    };
    const diagnostics = new Map<number, string>();
    const observeDiagnostics = (child: FixtureHostProcess) => {
      diagnostics.set(child.pid, "");
      child.stdout.resume();
      child.stderr.on("data", (chunk) => {
        diagnostics.set(child.pid, `${diagnostics.get(child.pid) ?? ""}${String(chunk)}`.slice(-4_000));
      });
    };
    const readReady = async (filename: string, child: FixtureHostProcess): Promise<FixtureReady> => {
      await waitForCondition(
        () => fs.existsSync(filename) || child.exitCode !== null || child.signalCode !== null,
        `fixture host ${child.pid} produced no ready evidence: ${diagnostics.get(child.pid) ?? ""}`,
        60_000,
      );
      if (!fs.existsSync(filename)) {
        throw new Error(`fixture host ${child.pid} exited before readiness: ${diagnostics.get(child.pid) ?? ""}`);
      }
      const result = JSON.parse(fs.readFileSync(filename, "utf8")) as FixtureReady | FixtureFailure;
      if ("error" in result) throw new Error(`fixture host ${child.pid} failed: ${result.error}`);
      return result;
    };
    const waitForChildExit = async (child: FixtureHostProcess, timeoutMs: number): Promise<boolean> => {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          new Promise<true>((resolve) => child.once("exit", () => resolve(true))),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const killExactEngine = async (identity: FixtureIdentity): Promise<void> => {
      if (procBackend.processIdentity(identity.pid) === identity.startIdentity) {
        try { process.kill(identity.pid, "SIGKILL"); } catch { /* fixture engine already exited */ }
      }
      await waitForCondition(
        () => procBackend.processIdentity(identity.pid) !== identity.startIdentity,
        `fixture engine ${identity.pid} survived termination`,
      );
    };
    const stopHost = async (
      child: FixtureHostProcess | null,
      engine: FixtureIdentity | null,
    ): Promise<void> => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        if (!await waitForChildExit(child, 1_000)) {
          child.kill("SIGKILL");
          await waitForChildExit(child, 1_000);
        }
      }
      if (engine) await killExactEngine(engine);
    };
    let incumbent: FixtureHostProcess | null = null;
    let successor: FixtureHostProcess | null = null;
    let incumbentEngine: FixtureIdentity | null = null;
    let successorEngine: FixtureIdentity | null = null;
    try {
      incumbent = launchHost("incumbent", incumbentReadyPath);
      observeDiagnostics(incumbent);
      const incumbentReady = await readReady(incumbentReadyPath, incumbent);
      incumbentEngine = incumbentReady.engine;
      expect(incumbentReady.mode).toBe("incumbent");
      expect(incumbentReady.viewer.pid).toBe(incumbent.pid);
      expect(incumbentReady.viewer.pid).not.toBe(process.pid);
      expect(incumbentReady.engine.pid).not.toBe(incumbentReady.viewer.pid);
      expect(incumbentReady.activeTurnRef).toBe("turn-1");

      incumbent.kill("SIGKILL");
      await waitForChildExit(incumbent, 1_000);
      await killExactEngine(incumbentReady.engine);
      const strandedRegistry = new AgentRegistry(registryPath).snapshot();
      expect(strandedRegistry.entries[`codex:${incumbentReady.sessionId}`]).toMatchObject({
        status: "live",
        claimOwner: expect.any(String),
        structuredHost: {
          process: { pid: incumbentReady.engine.pid },
          activeTurnRef: "turn-1",
        },
      });

      successor = launchHost("successor", successorReadyPath);
      observeDiagnostics(successor);
      const successorReady = await readReady(successorReadyPath, successor);
      successorEngine = successorReady.engine;
      expect(successorReady.mode).toBe("successor");
      expect(successorReady.sessionId).toBe(incumbentReady.sessionId);
      expect(successorReady.viewer.pid).toBe(successor.pid);
      expect(successorReady.viewer.pid).not.toBe(incumbentReady.viewer.pid);
      expect(successorReady.engine.pid).not.toBe(incumbentReady.engine.pid);
      expect(successorReady.engine.pid).not.toBe(successorReady.viewer.pid);
      expect(successorReady.proof).not.toHaveProperty("error");
      expect(successorReady.proof?.enginePid).toBe(successorReady.engine.pid);
      expect(successorReady.proof?.entry).toBe(entry === "source"
        ? path.resolve("src/lib/mcp/entry.ts") : path.resolve("bin/mcp-server.mjs"));
      expect(successorReady.proof?.toolNames).toContain("deployment_status");
      expect(successorReady.proof?.structuredContent).toMatchObject({
        ok: true,
        toolName: "deployment_status",
        clientRequestId: "seat-successor-deployment-status",
        count: 1,
        deployments: [deployment],
      });
      expect(controlRequests).toBe(1);
      const events = new FileRuntimeEventStore(eventsPath).load(successorReady.sessionId);
      expect(events).toContainEqual(expect.objectContaining({
        kind: "item",
        phase: "completed",
        item: expect.objectContaining({
          type: "mcpToolCall",
          server: "viewer",
          tool: "deployment_status",
          status: "completed",
        }),
      }));
      expect(events).toContainEqual(expect.objectContaining({ kind: "turn-ended", status: "completed" }));
      expect(new AgentRegistry(registryPath).snapshot().entries[`codex:${successorReady.sessionId}`])
        .toMatchObject({
          status: "idle",
          claimOwner: expect.any(String),
          structuredHost: {
            process: { pid: successorReady.engine.pid },
            activeTurnRef: null,
          },
        });
    } finally {
      await stopHost(successor, successorEngine);
      await stopHost(incumbent, incumbentEngine);
      control.stop(true);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  test("boot adoption starts only Codex rows admitted by its candidate filter", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-filtered-structured-adoption-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    for (const sessionId of ["unfinished-thread", "terminal-thread"]) {
      registry.upsert({
        key: { engine: "codex", sessionId },
        artifactPath: `/sessions/${sessionId}.jsonl`,
        cwd: "/repo",
        accountId: null,
        status: "live",
        host: null,
        structuredHost: {
          kind: "codex-app-server",
          endpoint: "stdio:old",
          process: null,
          eventCursor: 2,
          protocolVersion: "0.144.1",
          writerClaimEpoch: 1,
          activeTurnRef: `turn-${sessionId}`,
          pendingAttention: [],
          activeFlags: [],
        },
        claimEpoch: 1,
        claimOwner: null,
        pendingAction: null,
      });
    }
    const starts: string[] = [];
    const adopted = await adoptCodexRegistryHosts(
      registry,
      (entry) => {
        starts.push(entry.key.sessionId);
        return {
          cwd: "/repo",
          eventStore: new MemoryEventStore(),
          spawnProcess: fakeSpawn(new FakeAppServer(entry.key.sessionId)),
        };
      },
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
      (entry) => entry.key.sessionId === "unfinished-thread",
    );

    expect(starts).toEqual(["unfinished-thread"]);
    expect(adopted).toHaveLength(1);
    expect(registry.snapshot().entries["codex:terminal-thread"]).toMatchObject({
      status: "live",
      claimEpoch: 1,
      claimOwner: null,
    });
    await adopted[0]!.host.release();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("failed restart adoption leaves a loud dead structured host", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-failed-adoption-"));
    const registryPath = path.join(directory, "agent-registry.json");
    const registry = new AgentRegistry(registryPath);
    const key = { engine: "codex" as const, sessionId: "failed-adoption-thread" };
    registry.upsert({
      key,
      artifactPath: "/sessions/failed-adoption-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "unhosted",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:old",
        process: null,
        eventCursor: 9,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 2,
        activeTurnRef: "turn-old",
        pendingAttention: ["approval-old"],
        activeFlags: ["waitingForApproval"],
      },
      claimEpoch: 2,
      claimOwner: null,
      pendingAction: null,
    });
    const restartedRegistry = new AgentRegistry(registryPath);
    let adoptionAttempted = false;
    const adopted = await adoptCodexRegistryHosts(
      restartedRegistry,
      () => {
        adoptionAttempted = true;
        return {
          cwd: "/repo",
          eventStore: new MemoryEventStore(),
          spawnProcess: fakeSpawn(new FakeAppServer("failed-adoption-thread", "different-thread")),
        };
      },
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );
    expect(adopted).toEqual([]);
    expect(adoptionAttempted).toBeTrue();
    expect(restartedRegistry.snapshot().entries["codex:failed-adoption-thread"]).toMatchObject({
      status: "dead",
      host: null,
      claimOwner: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:released",
        process: null,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
    });
  });

  test("startup adoption retains an unreaped Codex child until late cleanup converges", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-uncertain-codex-adoption-"));
    const scratchDirectory = path.join(directory, "scratch");
    fs.mkdirSync(scratchDirectory);
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = "uncertain-codex-adoption";
    registry.upsert({
      key: { engine: "codex", sessionId },
      artifactPath: `/sessions/${sessionId}.jsonl`,
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:released",
        process: null,
        eventCursor: 9,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 2,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 2,
      claimOwner: null,
      pendingAction: null,
    });
    const server = new FakeAppServer(sessionId, "different-thread");

    const adopted = await adoptCodexRegistryHosts(
      registry,
      () => ({
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        shutdownGraceMs: 2,
        spawnProcess: fakeSpawn(server),
        signalProcess: () => {},
        releaseCleanup: () => fs.rmSync(scratchDirectory, { recursive: true, force: true }),
        ...ownedFakeProcess,
      }),
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );

    expect(adopted).toEqual([]);
    expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
      status: "idle",
      claimOwner: expect.any(String),
      structuredHost: {
        endpoint: "stdio:4242",
        process: { pid: 4242 },
        writerClaimEpoch: 3,
      },
    });
    expect(fs.existsSync(scratchDirectory)).toBeTrue();

    server.emit("close", 0, "SIGKILL");
    await waitForCondition(() => registry.snapshot().entries[`codex:${sessionId}`]?.status === "dead"
      && !fs.existsSync(scratchDirectory), "late native cleanup was not persisted");
    expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
      status: "dead",
      claimOwner: null,
      structuredHost: { endpoint: "stdio:released", process: null },
    });
    expect(fs.existsSync(scratchDirectory)).toBeFalse();
  });

  test("concurrent startup adoption creates one writer and advances its claim epoch", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-claim-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: "claimed-thread" };
    const eventStore = new FileRuntimeEventStore(path.join(directory, "events"));
    fs.mkdirSync(path.join(directory, "events"), { recursive: true });
    fs.writeFileSync(path.join(directory, "events", "claimed-thread.jsonl"), `${Array.from(
      { length: 2_907 },
      (_, index) => JSON.stringify({ kind: "session-status", status: "idle", seq: index + 1 }),
    ).join("\n")}\n`, { mode: 0o600 });
    registry.upsert({
      key,
      artifactPath: "/sessions/claimed-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:old",
        process: null,
        eventCursor: 2_908,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 8,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 8,
      claimOwner: null,
      pendingAction: null,
    });
    const servers: FakeAppServer[] = [];
    const adopt = () => adoptCodexRegistryHosts(
      registry,
      () => {
        const server = new FakeAppServer("claimed-thread", "claimed-thread", false, [], { type: "idle" }, {
          id: "concurrent-approval",
          method: "item/commandExecution/requestApproval",
          params: { command: "date" },
        });
        servers.push(server);
        return {
          cwd: "/repo",
          eventStore,
          onEventCursorRecovery: () => {},
          spawnProcess: fakeSpawn(server),
        };
      },
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );
    const [first, second] = await Promise.all([adopt(), adopt()]);
    expect(first.length + second.length).toBe(1);
    expect(servers).toHaveLength(1);
    expect(await adopt()).toEqual([]);
    expect(servers).toHaveLength(1);
    expect(registry.snapshot().entries["codex:claimed-thread"]).toMatchObject({
      claimEpoch: 9,
      structuredHost: {
        writerClaimEpoch: 9,
        eventCursor: 2_909,
        pendingAttention: [expect.stringContaining("item/commandExecution/requestApproval:concurrent-approval:")],
      },
    });
    await [...first, ...second][0]!.host.release();
  });

  test("late state from an old host cannot cross an advanced writer epoch", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-fence-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: "fenced-thread" };
    registry.upsert({
      key,
      artifactPath: "/sessions/fenced-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "idle",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:old",
        process: null,
        eventCursor: 0,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 1,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: "old-owner",
      pendingAction: null,
    });
    const server = new FakeAppServer("fenced-thread");
    const host = await CodexAppServerHost.adopt("fenced-thread", {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    await bindCodexHostPersistence(registry, key, host, "old-owner", 1);
    const started = await host.send({ id: "before-fence", text: "start" });
    expect(started).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    server.request("stale-approval", "item/commandExecution/requestApproval", { command: "date" });
    await Bun.sleep(0);
    const current = registry.snapshot().entries["codex:fenced-thread"]!;
    registry.upsert({
      ...current,
      structuredHost: {
        ...current.structuredHost!,
        endpoint: "stdio:new",
        eventCursor: 99,
        writerClaimEpoch: 2,
      },
      claimEpoch: 2,
      claimOwner: "new-owner",
    });
    const requestCount = server.requests.length;
    expect(await host.send({ id: "stale-send", text: "blocked", expectedTurnId: "turn-1" }))
      .toEqual({ outcome: "rejected", reason: "dead-host" });
    await expect(host.interrupt("turn-1")).rejects.toThrow("unavailable");
    await expect(host.answer("item/commandExecution/requestApproval:stale-approval", { decision: "accept" }))
      .rejects.toThrow("unavailable");
    expect(server.requests).toHaveLength(requestCount);
    server.notify("thread/status/changed", { threadId: "fenced-thread", status: { type: "active", activeFlags: ["running"] } });
    await Bun.sleep(0);
    expect(registry.snapshot().entries["codex:fenced-thread"]).toMatchObject({
      claimEpoch: 2,
      claimOwner: "new-owner",
      structuredHost: { endpoint: "stdio:new", eventCursor: 99, writerClaimEpoch: 2 },
    });
    await host.release();
  });

  test("structured status transitions advance migration readiness revisions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-revision-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const artifactPath = "/sessions/revision-thread.jsonl";
    registry.reconcileConversations([{
      engine: "codex",
      path: artifactPath,
      accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T20:00:00.000Z",
    }]);
    const key = { engine: "codex" as const, sessionId: "revision-thread" };
    registry.upsert({
      key,
      artifactPath,
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    const before = registry.snapshot();
    registry.setStructuredHost(key, {
      kind: "codex-app-server",
      endpoint: "stdio:42",
      process: { pid: 42, startIdentity: "42:start" },
      eventCursor: 1,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    }, "idle");
    const after = registry.snapshot();
    expect(after.conversationRevision.codex).toBe(before.conversationRevision.codex + 1);
    expect(after.engineRouting.codex.revision).toBe(before.engineRouting.codex.revision + 1);
  });
});
