import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { RuntimeHostClient } from "@/lib/runtime/client";
import type {
  RuntimeOperationCommand,
  RuntimeReceiptStatus,
  RuntimeTransitionDetails,
  RuntimeTransitionOptions,
} from "@/lib/runtime/contracts";

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
  const probeTarget = path.join(operatorPasswdHome, ".gemini", `llv-bwrap-s2-probe-${crypto.randomUUID().slice(0, 8)}`);
  const check = spawnSync(bwrapBin, [...baseArgs, "sh", "-c", `touch "$1"`, "_", probeTarget], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(check.status).not.toBe(0);
  expect(fs.existsSync(probeTarget)).toBe(false);
  return (command: string, args: string[], options: import("node:child_process").SpawnOptionsWithoutStdio) =>
    spawn(bwrapBin, [...baseArgs, command, ...args], options);
}

function sameOriginJsonRequest(url: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1",
      host: "127.0.0.1",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!RUN_REAL_AGY_E2E)("in-process Antigravity Slice 2 conversation-host E2E with real agy (AGY_E2E=1)", () => {
  test("spawns real agy, sends follow-up via /api/conversation-host, interrupts mid-turn with interrupt-then-turn-started receipt, kills, resumes via session/resume with retained context, and cleans up", async () => {
    const t0 = performance.now();
    const envKeys = [
      "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
      "LLV_STATE_DIR", "LLV_STATE_OWNER", "TMPDIR", "TMP", "TEMP",
      "LLV_SPAWN_TRANSPORT", "LLV_STRUCTURED_HOSTS", "LLV_RUNTIME_EVENTS",
      "LLV_RUNTIME_HOST_SOCKET", "NEXT_PUBLIC_RUNTIME_UI",
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};
    for (const key of envKeys) savedEnv[key] = process.env[key];
    const operatorHome = passwdHomeDir();

    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-agy-s2-e2e-"));
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
    process.env.LLV_SPAWN_TRANSPORT = "structured";
    process.env.LLV_STRUCTURED_HOSTS = "1";
    process.env.LLV_RUNTIME_EVENTS = "1";
    process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "unused.sock");
    process.env.NEXT_PUBLIC_RUNTIME_UI = "1";

    let store: import("@/lib/agent/registry").AgentRegistry | null = null;
    let journal: import("@/runtime-host/journal").RuntimeJournal | null = null;
    let liveHost: import("@/lib/runtime/antigravityAcpHost").AntigravityAcpHost | null = null;
    const allTrackedPids = new Set<number>();

    const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs: number, label: string) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((r) => setTimeout(r, 80));
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    };

    try {
      const [
        { POST: postSpawn },
        { conversationHostPOST },
        { setConversationHostDependenciesForTests },
        { applyConversationAction, CONVERSATION_ACTIONS },
        { AgentRegistry, setAgentRegistryForTests },
        { antigravityAccountForSpawn },
        { FileRuntimeEventStore },
        { spawnStructuredConversation, startAntigravityStructuredHost },
        { StructuredDeliveryQueue },
        { dispatchStructuredControl },
        { enqueueStructuredMessage },
        { recoverDeadStructuredConversation },
        { fencePendingSends, resolveSendReceipt },
        { resumeConversation, deliverConversationMessage },
        { RuntimeJournal },
      ] = await Promise.all([
        import("@/app/api/spawn/route"),
        import("@/app/api/conversation-host/handlers"),
        import("@/app/api/conversation-host/dependencies"),
        import("@/lib/conversation/actions"),
        import("@/lib/agent/registry"),
        import("@/lib/accounts/antigravity"),
        import("@/lib/runtime/eventStore"),
        import("@/lib/runtime/structuredSpawn"),
        import("@/lib/runtime/structuredDeliveryQueue"),
        import("@/lib/runtime/structuredControls"),
        import("@/lib/runtime/structuredMessageDelivery"),
        import("@/lib/runtime/structuredRecovery"),
        import("@/lib/runtime/sendSettlement"),
        import("@/lib/delivery"),
        import("@/runtime-host/journal"),
      ]);

      store = new AgentRegistry(path.join(stateDir, "agent-registry.json"), undefined, undefined, {
        sqliteMode: "sqlite",
        sqliteFilename: path.join(stateDir, "agent-registry.sqlite"),
      });
      setAgentRegistryForTests(store);

      const eventStore = new FileRuntimeEventStore(path.join(stateDir, "structured-host-events"));
      journal = new RuntimeJournal(path.join(sandbox, "runtime-events.sqlite"), {
        structuredHosts: true,
        maxEvents: 500,
      });
      const hostsByConversation = new Map<string, import("@/lib/runtime/antigravityAcpHost").AntigravityAcpHost>();
      let activeSessionKey: { engine: "antigravity"; sessionId: string } | null = null;
      let activeConversationId = "";

      const publishSessionToJournal = async (convId: string, hostState: "hosted" | "unhosted" | "dead") => {
        if (!activeSessionKey) return;
        const host = hostsByConversation.get(convId);
        const h = host ? await host.health() : null;
        const entry = store!.hostEntry(activeSessionKey);
        journal!.append({
          scope: { type: "session", id: convId },
          kind: "session-status",
          payload: {
            conversationId: convId,
            sessionKey: activeSessionKey,
            hostKind: "antigravity-acp",
            host: hostState,
            turn: h?.status === "active" ? "running" : h?.status === "attention" ? "attention" : "idle",
            activeTurnId: h?.activeTurnRef ?? null,
            attentionIds: h ? [...h.pendingAttention] : [],
            writerClaim: entry?.claimOwner ?? "claim-ag-s2:1",
            provenance: "structured",
            capabilities: { steer: false, steerMode: "interrupt", structuredAttention: true, imageInput: { supported: true } },
          },
        });
      };

      const currentSessionSnapshot = async (convId: string) => {
        const host = hostsByConversation.get(convId);
        if (!host || !activeSessionKey) return journal!.readSession({ conversationId: convId });
        const h = await host.health();
        const entry = store!.hostEntry(activeSessionKey);
        return {
          conversationId: convId,
          sessionKey: activeSessionKey,
          hostKind: "antigravity-acp" as const,
          host: h.status === "dead" ? "dead" as const : h.status === "unhosted" ? "unhosted" as const : "hosted" as const,
          turn: h.status === "active" ? "running" as const : h.status === "attention" ? "attention" as const : "idle" as const,
          activeTurnId: h.activeTurnRef,
          attentionIds: [...h.pendingAttention],
          capabilities: { steer: false, steerMode: "interrupt" as const, structuredAttention: true, imageInput: { supported: true } },
          revision: journal!.readSession({ conversationId: convId })?.revision ?? 1,
          writerClaim: entry?.claimOwner ?? "claim-ag-s2:1",
        };
      };

      const inProcessClient = {
        command: async (cmd: RuntimeOperationCommand) => journal!.executeOperation(cmd),
        operationStatus: async (id: string) => journal!.operationResult(id),
        effectBatch: async (kinds: readonly string[], afterSeq: number) => journal!.effectBatch(100, kinds, afterSeq),
        readSession: async (target: { conversationId?: string }) => currentSessionSnapshot(target.conversationId ?? activeConversationId),
        session: async (target: { conversationId?: string }) => currentSessionSnapshot(target.conversationId ?? activeConversationId),
        transitionOperation: async (
          id: string,
          status: Exclude<RuntimeReceiptStatus, "pending">,
          details?: RuntimeTransitionDetails,
          options?: RuntimeTransitionOptions,
        ) => journal!.transitionOperation(id, status, details, options),
      } as unknown as RuntimeHostClient;

      const queue = new StructuredDeliveryQueue(
        {
          effects: async (kinds, afterSeq) => journal!.effectBatch(100, kinds, afterSeq),
          status: async (id) => journal!.operationResult(id)?.receipt ?? null,
          hostClaim: async () => "claim-ag-s2:1",
          fencePendingSends: (operationIds) => fencePendingSends(operationIds, { registry: store!, client: inProcessClient }),
          transition: async (id, status, details, options) => {
            journal!.transitionOperation(id, status, details, options);
          },
        },
        (convId) => hostsByConversation.get(convId) ?? null,
        async (convId, sessionKey) => {
          const host = hostsByConversation.get(convId);
          if (host) {
            await host.release();
            hostsByConversation.delete(convId);
            if (liveHost === host) liveHost = null;
          }
          store!.terminateStructuredHost(sessionKey);
          await publishSessionToJournal(convId, "unhosted");
          return true;
        },
      );

      const startConfinedHost = async (
        spawnInput: Parameters<typeof startAntigravityStructuredHost>[0],
        capability: string,
      ) => {
        const host = await startAntigravityStructuredHost(spawnInput, capability, {
          viewerMcpServer: null,
          mcpServers: [],
          eventStore,
          spawnProcess: confinedSpawnProcess,
          requestTimeoutMs: 45_000,
          interruptTimeoutMs: 15_000,
        });
        liveHost = host;
        hostsByConversation.set(spawnInput.receipt.conversationId, host);
        activeSessionKey = { engine: "antigravity", sessionId: host.identity.sessionId };
        activeConversationId = spawnInput.receipt.conversationId;
        await publishSessionToJournal(spawnInput.receipt.conversationId, "hosted");
        const h = await host.health();
        if (h.pid) {
          for (const pid of collectDescendantPids(h.pid)) allTrackedPids.add(pid);
        }
        return host;
      };

      const inProcessRecover: typeof recoverDeadStructuredConversation = (req, deps) =>
        recoverDeadStructuredConversation(req, {
          ...deps,
          registry: store!,
          client: inProcessClient,
          transportAvailable: () => true,
          resolveAccount: (_eng, accId) => antigravityAccountForSpawn(accId),
          spawn: (input) => spawnStructuredConversation(input, {
            durableSetupTimeoutMs: 60_000,
            startHost: startConfinedHost,
            publishHost: async () => async () => {},
          }),
        });

      const inProcessDispatchControl: typeof dispatchStructuredControl = (req, deps) =>
        dispatchStructuredControl(req, {
          ...deps,
          registry: store!,
          client: inProcessClient,
          enabled: () => true,
          kick: () => {},
          recover: inProcessRecover,
          republish: async () => Boolean(hostsByConversation.get(activeConversationId)),
        });

      setConversationHostDependenciesForTests({
        conversationActions: CONVERSATION_ACTIONS,
        completedFileScan: async () => ({ snapshot: { files: [] } }) as never,
        recordOperatorRequest: () => null,
        priorSubmission: () => "not-executed",
        dispatchStructuredControl: inProcessDispatchControl,
        applyConversationAction: (req) => applyConversationAction(req, {
          registry: () => store!,
          structuredEnabled: () => true,
          dispatchStructuredControl: inProcessDispatchControl,
          resumeConversation: (filePath) => resumeConversation(filePath, {
            registry: store!,
            recover: inProcessRecover,
          }),
        }),
        enqueueStructuredMessage: (req) => enqueueStructuredMessage(req, {
          registry: () => store!,
          client: () => inProcessClient,
          kick: () => {},
          republish: async () => Boolean(hostsByConversation.get(req.conversationId ?? activeConversationId)),
          recover: inProcessRecover,
        }),
        deliverConversationMessage: (msg) => deliverConversationMessage(msg, {
          recover: inProcessRecover,
        }),
      });

      const drainOperation = async (operationId: string, label: string, timeoutMs = 20_000) => {
        await waitUntil(async () => {
          await queue.drain({ freshAdmission: true });
          const status = journal!.operationResult(operationId)?.receipt.status;
          return status === "delivered" || status === "failed" || status === "rejected" || status === "uncertain";
        }, timeoutMs, label);
      };

      const secretToken = "SLICE2-TOKEN-7491";

      // 1. Spawn via POST /api/spawn and remember secretToken.
      const deferred: Array<() => Promise<void>> = [];
      const spawnRes = await postSpawn.withDependencies(sameOriginJsonRequest("http://127.0.0.1/api/spawn", {
        title: "Antigravity Slice 2 E2E",
        engine: "antigravity",
        model: "gemini-3.8-flash-low",
        cwd,
        ["prompt"]: `Remember the secret code ${secretToken} and reply with exactly: READY_S2`,
        clientAttemptId: `ag_s2_${crypto.randomUUID().slice(0, 8)}`,
      }), {
        registry: () => store!,
        assertStructuredRuntime: () => {},
        storeImages: () => [],
        resolveHealthySpawnAccount: async (_e, req) => antigravityAccountForSpawn(req),
        resolveSpawnAccount: (_e, req) => antigravityAccountForSpawn(req),
        resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
        runtimeHostClient: () => inProcessClient,
        defer: (work) => { deferred.push(work); },
        spawnStructuredConversation: async (input) => spawnStructuredConversation(input, {
          durableSetupTimeoutMs: 60_000,
          startHost: startConfinedHost,
          publishHost: async () => async () => {},
          deliverFirst: async (spawnInput) => {
            const host = hostsByConversation.get(spawnInput.receipt.conversationId)!;
            const receipt = await host.send({ id: `spawn_message_${spawnInput.receipt.launchId}`, text: spawnInput.prompt });
            if (receipt.outcome === "rejected") throw new Error(`first prompt rejected: ${receipt.reason}`);
          },
        }),
      });
      expect(spawnRes.status).toBe(202);
      const spawnBody = await spawnRes.json() as { conversationId: string };
      const conversationId = spawnBody.conversationId;
      for (const work of deferred) await work();
      expect(liveHost).not.toBeNull();
      const transcriptPath = liveHost!.identity.path;
      const firstPid = (await liveHost!.health()).pid!;
      await waitUntil(async () => (await liveHost!.health()).status === "idle", 45_000, "turn 1 idle");

      // 2. Follow-up send via POST /api/conversation-host -> drain -> verify message_receipt delivered.
      const followUpRes = await conversationHostPOST(sameOriginJsonRequest("http://127.0.0.1/api/conversation-host", {
        conversationId,
        path: transcriptPath,
        clientMessageId: `s2-follow-${crypto.randomUUID().slice(0, 8)}`,
        text: "Reply with exactly: FOLLOWUP_OK",
      }));
      expect(followUpRes.status).toBe(200);
      const followUpBody = await followUpRes.json() as { ok: true; operationId: string };
      expect(followUpBody.ok).toBe(true);
      await drainOperation(followUpBody.operationId, "follow-up delivered");
      const followReceipt = await resolveSendReceipt(followUpBody.operationId, { registry: store!, client: inProcessClient });
      expect(followReceipt?.state).toBe("delivered");
      await waitUntil(async () => (await liveHost!.health()).status === "idle", 45_000, "follow-up idle");

      // 3. Mid-turn send via POST /api/conversation-host -> interrupt-then-turn-started + interruptedTurnId!
      const slowRes = await conversationHostPOST(sameOriginJsonRequest("http://127.0.0.1/api/conversation-host", {
        conversationId,
        path: transcriptPath,
        clientMessageId: `s2-slow-${crypto.randomUUID().slice(0, 8)}`,
        text: "Write a detailed 1500-word essay about prime numbers from 1 to 500, explaining each prime in its own numbered paragraph.",
      }));
      expect(slowRes.status).toBe(200);
      const slowBody = await slowRes.json() as { ok: true; operationId: string };
      await drainOperation(slowBody.operationId, "slow turn delivered");
      await waitUntil(async () => {
        const h = await liveHost!.health();
        return h.status === "active" && Boolean(h.activeTurnRef);
      }, 15_000, "slow turn active");
      const slowTurnId = (await liveHost!.health()).activeTurnRef!;

      const interruptRes = await conversationHostPOST(sameOriginJsonRequest("http://127.0.0.1/api/conversation-host", {
        conversationId,
        path: transcriptPath,
        clientMessageId: `s2-interrupt-${crypto.randomUUID().slice(0, 8)}`,
        text: "Stop the essay and reply with exactly: INTERRUPT_OK",
      }));
      expect(interruptRes.status).toBe(200);
      const interruptBody = await interruptRes.json() as { ok: true; operationId: string };
      await drainOperation(interruptBody.operationId, "interrupt follow-up delivered");
      const interruptReceipt = await resolveSendReceipt(interruptBody.operationId, { registry: store!, client: inProcessClient });
      expect(interruptReceipt?.state).toBe("delivered");
      expect(interruptReceipt?.delivery).toBe("interrupt-then-turn-started");
      expect(interruptReceipt?.interruptedTurnId).toBe(slowTurnId);
      await waitUntil(async () => (await liveHost!.health()).status === "idle", 45_000, "interrupted follow-up idle");

      // 4. Kill via POST /api/conversation-host -> drain runtime.kill -> verify first agy child reaped!
      const killRes = await conversationHostPOST(sameOriginJsonRequest("http://127.0.0.1/api/conversation-host", {
        conversationId,
        path: transcriptPath,
        action: "kill",
      }));
      const killBody = await killRes.json() as { ok?: boolean; operationId?: string; outcome?: string; error?: string; receipt?: { status?: string; reason?: string } };
      expect({ status: killRes.status, body: killBody }).toMatchObject({ status: 202, body: { ok: true } });
      await drainOperation(killBody.operationId!, "kill delivered");
      expect(liveHost).toBeNull();
      await waitUntil(() => !isPidAlive(firstPid), 10_000, "first agy child reaped");

      // 5. Resume via POST /api/conversation-host -> session/resume -> verify secretToken preserved!
      const resumeRes = await conversationHostPOST(sameOriginJsonRequest("http://127.0.0.1/api/conversation-host", {
        conversationId,
        path: transcriptPath,
        action: "resume",
      }));
      expect(resumeRes.status).toBe(200);
      const resumeBody = await resumeRes.json() as { ok: true; outcome: string; spawned?: boolean };
      expect(resumeBody.ok).toBe(true);
      expect(resumeBody.outcome).toBe("resumed");
      expect(resumeBody.spawned).toBe(true);
      expect(liveHost).not.toBeNull();
      const resumedPid = (await liveHost!.health()).pid!;
      expect(resumedPid).not.toBe(firstPid);

      const recallRes = await conversationHostPOST(sameOriginJsonRequest("http://127.0.0.1/api/conversation-host", {
        conversationId,
        path: transcriptPath,
        clientMessageId: `s2-recall-${crypto.randomUUID().slice(0, 8)}`,
        text: "What exact secret code did I ask you to remember in the very first message? Reply with ONLY that code.",
      }));
      expect(recallRes.status).toBe(200);
      const recallBody = await recallRes.json() as { ok: true; operationId: string };
      await drainOperation(recallBody.operationId, "recall delivered");
      await waitUntil(async () => (await liveHost!.health()).status === "idle", 45_000, "recall turn idle");

      const records = fs.readFileSync(transcriptPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
      expect(records.some((r) => r.type === "session.resume")).toBe(true);
      const lastAssistant = [...records].reverse().find((r) => r.type === "assistant.message");
      expect(String(lastAssistant?.data.content ?? "")).toContain(secretToken);

      // 6. Clean teardown: release host and assert zero surviving child PIDs.
      await liveHost!.release();
      liveHost = null;
      await waitUntil(() => [...allTrackedPids].every((pid) => !isPidAlive(pid)), 10_000, "all agy PIDs reaped");

      console.info(`[antigravity-slice2-e2e] totalMs=${Math.round(performance.now() - t0)} records=${records.length}`);
    } finally {
      try {
        const { setConversationHostDependenciesForTests } = await import("@/app/api/conversation-host/dependencies");
        setConversationHostDependenciesForTests(null);
      } catch { /* ignore */ }
      try {
        const { setAgentRegistryForTests } = await import("@/lib/agent/registry");
        setAgentRegistryForTests(null);
      } catch { /* ignore */ }
      const remainingHost = liveHost as import("@/lib/runtime/antigravityAcpHost").AntigravityAcpHost | null;
      if (remainingHost) {
        try { await remainingHost.release(); } catch { /* ignore */ }
      }
      for (const pid of allTrackedPids) {
        if (isPidAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* exited */ }
        }
      }
      journal?.close();
      store?.close();
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      makeWritableRecursive(sandbox);
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }, 180_000);
});
