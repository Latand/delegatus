import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const RUN_REAL_AGY_E2E = process.env.AGY_E2E === "1";

function collectDescendantPids(rootPid: number): Set<number> {
  const pids = new Set<number>([rootPid]);
  if (process.platform !== "linux") return pids;
  try {
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pids.has(pid)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
          const closeParen = stat.lastIndexOf(")");
          if (closeParen < 0) continue;
          const fields = stat.slice(closeParen + 2).split(" ");
          const ppid = Number(fields[1]);
          if (pids.has(ppid)) {
            pids.add(pid);
            changed = true;
          }
        } catch { /* exited */ }
      }
    }
  } catch { /* /proc unavailable */ }
  return pids;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function makeWritableRecursive(dir: string): void {
  if (!fs.existsSync(dir)) return;
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.chmodSync(dir, 0o700);
      for (const entry of fs.readdirSync(dir)) makeWritableRecursive(path.join(dir, entry));
    } else {
      fs.chmodSync(dir, 0o600);
    }
  } catch { /* best effort */ }
}

function passwdHomeDir(): string {
  if (process.platform === "linux" && typeof process.getuid === "function") {
    const uid = String(process.getuid());
    try {
      for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
        const fields = line.split(":");
        if (fields[2] === uid && fields[5]) return fields[5];
      }
    } catch { /* fall back */ }
  }
  return os.userInfo().homedir;
}

function copyLoginFileReadOnly(src: string, dst: string): boolean {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o400);
  return true;
}

function assertAndCreateBwrapSpawner(sandbox: string, operatorPasswdHome: string) {
  const bwrapBin = "/usr/bin/bwrap";
  if (process.platform !== "linux" || !fs.existsSync(bwrapBin)) {
    throw new Error("kernel write-confinement proof requires /usr/bin/bwrap on Linux");
  }
  const baseArgs = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--bind", sandbox, sandbox,
    "--die-with-parent",
    "--",
  ];
  const probeTarget = path.join(operatorPasswdHome, ".gemini", `llv-bwrap-s4-probe-${crypto.randomUUID().slice(0, 8)}`);
  const check = spawnSync(bwrapBin, [...baseArgs, "sh", "-c", `touch "$1"`, "_", probeTarget], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(check.status).not.toBe(0);
  expect(fs.existsSync(probeTarget)).toBe(false);
  return (command: string, args: string[], options: import("node:child_process").SpawnOptionsWithoutStdio) =>
    spawn(bwrapBin, [...baseArgs, command, ...args], options);
}

describe.skipIf(!RUN_REAL_AGY_E2E)("in-process Antigravity Slice 4 limits & quota reporting E2E with real agy (AGY_E2E=1)", () => {
  test("runs real agy in bwrap, surfaces quota exhaustion through /api/limits, QuotaController, MCP account_limits, and card feed, expires cleanly after resetsAt, and reaps all PIDs", async () => {
    const t0 = performance.now();
    const envKeys = [
      "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
      "LLV_STATE_DIR", "LLV_STATE_OWNER", "TMPDIR", "TMP", "TEMP",
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};
    for (const key of envKeys) savedEnv[key] = process.env[key];
    const operatorHome = passwdHomeDir();

    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-agy-s4-e2e-"));
    const tempHome = path.join(sandbox, "home");
    const xdgConfig = path.join(sandbox, "xdg-config");
    const xdgCache = path.join(sandbox, "xdg-cache");
    const xdgData = path.join(sandbox, "xdg-data");
    const xdgState = path.join(sandbox, "xdg-state");
    const stateDir = path.join(xdgConfig, "agent-log-viewer", "state");
    const tempTmp = path.join(sandbox, "tmp");
    const cwd = path.join(sandbox, "workspace");
    for (const dir of [tempHome, xdgConfig, xdgCache, xdgData, xdgState, stateDir, tempTmp, cwd]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const operatorGemini = path.join(operatorHome, ".gemini");
    for (const rel of [
      "google_accounts.json",
      "oauth_creds.json",
      "antigravity-cli/oauth_creds.json",
      "antigravity-cli/google_accounts.json",
      "antigravity-cli/settings.json",
    ]) {
      copyLoginFileReadOnly(path.join(operatorGemini, rel), path.join(tempHome, ".gemini", rel));
    }

    const confinedSpawnProcess = assertAndCreateBwrapSpawner(sandbox, operatorHome);

    process.env.HOME = tempHome;
    process.env.XDG_CONFIG_HOME = xdgConfig;
    process.env.XDG_CACHE_HOME = xdgCache;
    process.env.XDG_DATA_HOME = xdgData;
    process.env.XDG_STATE_HOME = xdgState;
    process.env.LLV_STATE_DIR = stateDir;
    process.env.LLV_STATE_OWNER = "test";
    process.env.TMPDIR = tempTmp;
    process.env.TMP = tempTmp;
    process.env.TEMP = tempTmp;

    const trackedPids = new Set<number>();
    let host: import("@/lib/runtime/antigravityAcpHost").AntigravityAcpHost | null = null;
    let registry: import("@/lib/agent/registry").AgentRegistry | null = null;

    try {
      const [
        { AntigravityAcpHost },
        { FileRuntimeEventStore },
        { AgentRegistry, setAgentRegistryForTests },
        { antigravityDefaultHome },
        { parseAntigravityQuotaError },
        { readLimits },
        { GET: getLimits },
        { QuotaController, liveQuotaProbe },
        { viewerMcpBindings },
        { buildFeed },
      ] = await Promise.all([
        import("@/lib/runtime/antigravityAcpHost"),
        import("@/lib/runtime/eventStore"),
        import("@/lib/agent/registry"),
        import("@/lib/accounts/antigravity"),
        import("@/lib/limits/antigravityQuota"),
        import("@/lib/limits"),
        import("@/app/api/limits/route"),
        import("@/lib/accounts/migration/quotaController"),
        import("@/lib/mcp/bindings"),
        import("@/components/feed/parse"),
      ]);

      registry = new AgentRegistry(path.join(stateDir, "agent-registry.json"), undefined, undefined, {
        sqliteMode: "sqlite",
        sqliteFilename: path.join(stateDir, "agent-registry.sqlite"),
      });
      setAgentRegistryForTests(registry);

      const antigravityHome = antigravityDefaultHome();
      const eventStore = new FileRuntimeEventStore(path.join(stateDir, "structured-host-events"));

      // 1. Start a real agy ACP session in bwrap and run one real turn cleanly.
      host = await AntigravityAcpHost.start({
        cwd,
        antigravityHome,
        accountId: "default",
        model: "gemini-3.8-flash",
        effort: "low",
        allowAll: true,
        viewerMcpServer: null,
        mcpServers: [],
        eventStore,
        spawnProcess: confinedSpawnProcess,
        requestTimeoutMs: 45_000,
      });
      const health = await host.health();
      if (health.pid) {
        for (const pid of collectDescendantPids(health.pid)) trackedPids.add(pid);
      }

      const sent = await host.send({
        id: `s4-turn-${crypto.randomUUID().slice(0, 8)}`,
        text: "Reply with exactly: SLICE4_READY",
        origin: { kind: "operator" },
      });
      expect(sent.outcome).toBe("turn-started");
      const stream = host.attach(0)[Symbol.asyncIterator]();
      const deadline = Date.now() + 60_000;
      let turnEnded = false;
      while (!turnEnded && Date.now() < deadline) {
        const next = await Promise.race([
          stream.next(),
          new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 5_000)),
        ]);
        if (next.done || !next.value) continue;
        if (next.value.kind === "turn-ended") turnEnded = true;
      }
      expect(turnEnded).toBe(true);
      const transcriptPath = host.identity.path;
      await host.release();
      host = null;
      await new Promise((r) => setTimeout(r, 150));
      for (const pid of trackedPids) expect(isPidAlive(pid)).toBe(false);

      // 2. Append a parsed RESOURCE_EXHAUSTED record (same schema AntigravityAcpHost writes)
      //    and verify the full Slice 4 surface: QuotaController -> /api/limits -> MCP account_limits -> feed card.
      const observedMs = Date.now();
      const parsed = parseAntigravityQuotaError(
        "RESOURCE_EXHAUSTED: Individual quota reached for gemini-3.8-flash. Resets in 2h 30m",
        observedMs,
      )!;
      expect(parsed.resetsAt).not.toBeNull();
      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: "session.quota_exhausted",
          timestamp: new Date(observedMs).toISOString(),
          data: {
            turnId: "turn_s4_quota",
            code: "RESOURCE_EXHAUSTED",
            message: parsed.message,
            resetsAt: parsed.resetsAt,
            windowMinutes: parsed.windowMinutes,
            usedPercent: parsed.usedPercent,
            observedAt: parsed.observedAt,
          },
        })}\n`,
      );

      let clockMs = observedMs + 30_000;
      const controller = new QuotaController(registry, liveQuotaProbe, "slice4-e2e", () => clockMs);
      await controller.tick("antigravity");

      const obs = registry.quotaObservations("antigravity");
      expect(obs).toHaveLength(1);
      expect(obs[0]).toMatchObject({
        engine: "antigravity",
        accountId: "default",
        limitReached: true,
        provenance: { source: "transcript" },
        limits: { session: { usedPercent: 100, windowMinutes: 300, resetsAt: parsed.resetsAt } },
      });

      const apiRes = await getLimits();
      expect(apiRes.status).toBe(200);
      const payload = await apiRes.json() as import("@/lib/types").LimitsPayload;
      expect(payload.antigravityAccountId).toBe("default");
      expect(payload.antigravity?.session).toMatchObject({
        usedPercent: 100,
        windowMinutes: 300,
        resetsAt: parsed.resetsAt,
      });
      expect(payload.provenance.antigravity?.source).toBe("transcript");

      const bindings = viewerMcpBindings();
      const mcpLimits = await bindings.account_limits({
        clientRequestId: `s4-mcp-${crypto.randomUUID().slice(0, 8)}`,
        engine: "antigravity",
      }) as { count: number; accounts: Array<{ engine: string; accountId: string; session: { usedPercent: number; resetsAt: string } | null }> };
      expect(mcpLimits.count).toBe(1);
      expect(mcpLimits.accounts[0]).toMatchObject({
        engine: "antigravity",
        accountId: "default",
        session: {
          usedPercent: 100,
          resetsAt: new Date(parsed.resetsAt! * 1000).toISOString(),
        },
      });

      // Card feed renders the quota exhaustion stop reason clearly.
      const parsedFeed = buildFeed(
        { path: transcriptPath, engine: "antigravity", fmt: "antigravity", activity: "recent" } as import("@/lib/types").FileEntry,
        fs.readFileSync(transcriptPath, "utf8").trim().split("\n"),
        false,
        "",
      ).items;
      expect(parsedFeed.some((item) => item.kind === "note" && item.text.includes("Individual quota reached"))).toBe(true);

      // 3. Advance clock past resetsAt: QuotaController + readLimits clear the stale exhaustion.
      clockMs = parsed.resetsAt! * 1000 + 5_000;
      await controller.tick("antigravity");
      expect(registry.quotaObservations("antigravity")[0]?.limits).toBeNull();
      expect(registry.quotaObservations("antigravity")[0]?.limitReached).toBe(false);
      const afterReset = await readLimits({ now: () => clockMs });
      expect(afterReset.antigravity).toBeNull();
      expect(afterReset.provenance.antigravity?.source).toBe("unavailable");

      console.info(`[agy-slice4-e2e] PASS in ${((performance.now() - t0) / 1000).toFixed(2)}s, resetsAt=${parsed.resetsAt}`);
    } finally {
      if (host) {
        try { await host.release(); } catch { /* ignore */ }
      }
      for (const pid of trackedPids) {
        if (isPidAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* exited */ }
        }
      }
      try {
        const { setAgentRegistryForTests } = await import("@/lib/agent/registry");
        setAgentRegistryForTests(null);
      } catch { /* ignore */ }
      registry?.close();
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      makeWritableRecursive(sandbox);
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }, 120_000);
});
