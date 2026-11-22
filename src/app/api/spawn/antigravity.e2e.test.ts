import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";

import type { AgentRegistryEntry } from "@/lib/agent/registry";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type {
  RuntimeOperationCommand,
  RuntimeReceiptStatus,
  RuntimeTransitionDetails,
  RuntimeTransitionOptions,
} from "@/lib/runtime/contracts";

const RUN_REAL_AGY_E2E = process.env.AGY_E2E === "1";

const PREVIOUS_RELEASE_NATIVE_CALLER_HOST = `collection='entries'
  AND json_extract(value_json,'$.structuredHost.kind') IN ('codex-app-server','claude-broker','copilot-acp')
  AND NOT COALESCE((
    json_extract(value_json,'$.status')='dead'
    AND json_extract(value_json,'$.structuredHost.endpoint')='stdio:released'
    AND (
      (json_extract(value_json,'$.structuredHost.signalDomain.policyVersion')=1
        AND json_type(value_json,'$.structuredHost.signalDomain.retired')='true')
      OR (json_extract(value_json,'$.structuredHost.signalDomain') IS NULL
        AND json_type(value_json,'$.structuredHost.eventCursor') IN ('integer','real')
        AND json_extract(value_json,'$.structuredHost.eventCursor')>0
        AND json_extract(value_json,'$.structuredHost.exitProcess') IS NULL
        AND json_extract(value_json,'$.hostExitProcess') IS NULL
        AND COALESCE(json_array_length(value_json,'$.pendingHostExits'),0)=0)
    )
    AND json_extract(value_json,'$.host') IS NULL
    AND json_extract(value_json,'$.structuredHost.process') IS NULL
    AND json_extract(value_json,'$.structuredHost.scope') IS NULL
    AND json_extract(value_json,'$.structuredHost.memory.unit') IS NULL
    AND json_extract(value_json,'$.claimOwner') IS NULL
    AND json_extract(value_json,'$.pendingAction') IS NULL
    AND COALESCE(json_array_length(value_json,'$.structuredTerminationSurvivors'),0)=0
  ),0)`;

function downgradeRegistryToV1NativeCallerSchema(sqlitePath: string): void {
  const db = new Database(sqlitePath);
  try {
    const pathFrom = (row: "OLD" | "NEW") => `json_extract(${row}.value_json,'$.artifactPath')`;
    const eligible = (row: "OLD" | "NEW") => `COALESCE((${PREVIOUS_RELEASE_NATIVE_CALLER_HOST
      .replaceAll("collection", `${row}.collection`).replaceAll("value_json", `${row}.value_json`)}
      AND json_type(${row}.value_json,'$.artifactPath')='text' AND ${pathFrom(row)}<>''),0)`;
    const add = `INSERT INTO registry_native_host_paths(path)
      SELECT ${pathFrom("NEW")} WHERE ${eligible("NEW")} ON CONFLICT(path) DO NOTHING;`;
    const remove = `DELETE FROM registry_native_host_paths WHERE path=${pathFrom("OLD")} AND ${eligible("OLD")}
      AND NOT EXISTS (SELECT 1 FROM registry_rows INDEXED BY registry_caller_native_host_artifact
        WHERE ${PREVIOUS_RELEASE_NATIVE_CALLER_HOST} AND json_extract(value_json,'$.artifactPath')=${pathFrom("OLD")});`;
    db.exec(`
      DROP TRIGGER IF EXISTS registry_native_host_paths_insert;
      DROP TRIGGER IF EXISTS registry_native_host_paths_delete;
      DROP TRIGGER IF EXISTS registry_native_host_paths_update;
      DROP INDEX IF EXISTS registry_caller_native_host_artifact_v2;
      DROP INDEX IF EXISTS registry_caller_native_host_artifact;
      CREATE INDEX registry_caller_native_host_artifact ON registry_rows(json_extract(value_json,'$.artifactPath'))
        WHERE ${PREVIOUS_RELEASE_NATIVE_CALLER_HOST};
      DELETE FROM registry_native_host_paths;
      INSERT INTO registry_native_host_paths
        SELECT DISTINCT json_extract(value_json,'$.artifactPath')
        FROM registry_rows INDEXED BY registry_caller_native_host_artifact
        WHERE ${PREVIOUS_RELEASE_NATIVE_CALLER_HOST}
          AND json_type(value_json,'$.artifactPath')='text'
          AND json_extract(value_json,'$.artifactPath')<>'';
      CREATE TRIGGER registry_native_host_paths_insert AFTER INSERT ON registry_rows WHEN ${eligible("NEW")} BEGIN ${add} END;
      CREATE TRIGGER registry_native_host_paths_delete AFTER DELETE ON registry_rows WHEN ${eligible("OLD")} BEGIN ${remove} END;
      CREATE TRIGGER registry_native_host_paths_update AFTER UPDATE ON registry_rows
        WHEN (${eligible("OLD")} OR ${eligible("NEW")})
          AND (${pathFrom("OLD")} IS NOT ${pathFrom("NEW")} OR ${eligible("OLD")} IS NOT ${eligible("NEW")})
        BEGIN ${remove} ${add} END;
      DELETE FROM registry_meta WHERE key='native_caller_artifacts_revision';
      INSERT OR REPLACE INTO registry_meta(key,value) VALUES ('native_caller_artifacts_version','1');
    `);
  } finally {
    db.close();
  }
}

function makeSeedEntry(
  engine: "claude" | "codex" | "copilot",
  sessionId: string,
  artifactPath: string,
): Omit<AgentRegistryEntry, "updatedAt"> {
  const kind = engine === "claude"
    ? "claude-broker"
    : engine === "codex"
      ? "codex-app-server"
      : "copilot-acp";
  return {
    key: { engine, sessionId },
    artifactPath,
    cwd: path.dirname(artifactPath),
    accountId: null,
    status: "live",
    host: null,
    structuredHost: {
      kind,
      endpoint: `stdio:${kind}`,
      process: { pid: 88100, startIdentity: `88100:${sessionId}`, bootEpoch: "e2e-seed" },
      protocolVersion: "1",
      writerClaimEpoch: 1,
      eventCursor: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${engine}`,
    pendingAction: null,
  };
}

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
        } catch { /* process exited */ }
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
      for (const entry of fs.readdirSync(dir)) {
        makeWritableRecursive(path.join(dir, entry));
      }
    } else {
      fs.chmodSync(dir, 0o600);
    }
  } catch { /* best effort cleanup */ }
}

function passwdHomeDir(): string {
  if (process.platform === "linux" && typeof process.getuid === "function") {
    const uid = String(process.getuid());
    try {
      for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
        const fields = line.split(":");
        if (fields[2] === uid && fields[5]) return fields[5];
      }
    } catch { /* fall back to os.userInfo */ }
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

/** Verifies bubblewrap enforces MS_RDONLY everywhere outside `sandbox`, then wraps
    any spawned `agy` process tree so the Linux kernel rejects external writes with EROFS. */
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
  // Positive controls: kernel MUST refuse writes outside sandbox with Read-only file system.
  for (const probeTarget of [
    path.join("/tmp", `llv-bwrap-ro-probe-${crypto.randomUUID().slice(0, 8)}`),
    path.join(operatorPasswdHome, ".gemini", `llv-bwrap-ro-probe-${crypto.randomUUID().slice(0, 8)}`),
  ]) {
    const check = spawnSync(bwrapBin, [...baseArgs, "sh", "-c", `touch "$1"`, "_", probeTarget], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(check.status).not.toBe(0);
    expect(`${check.stderr}${check.stdout}`).toMatch(/Read-only file system|Permission denied|No such file/i);
    expect(fs.existsSync(probeTarget)).toBe(false);
  }
  return (command: string, args: string[], options: import("node:child_process").SpawnOptionsWithoutStdio) =>
    spawn(bwrapBin, [...baseArgs, command, ...args], options);
}

describe.skipIf(!RUN_REAL_AGY_E2E)("in-process Antigravity E2E with real agy (AGY_E2E=1)", () => {
  test("runs /api/roles, migrates v1 registry, spawns real agy via POST /api/spawn, confirms second delivery via owner fact, confines writes, and cleans up", async () => {
    const t0 = performance.now();
    const timings: Record<string, number> = {};
    const mark = (name: string, start: number) => {
      timings[name] = Math.round(performance.now() - start);
    };

    const envKeys = [
      "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
      "LLV_STATE_DIR", "LLV_STATE_OWNER", "TMPDIR", "TMP", "TEMP",
      "LLV_SPAWN_TRANSPORT", "LLV_STRUCTURED_HOSTS", "LLV_RUNTIME_EVENTS",
      "LLV_RUNTIME_HOST_SOCKET", "NEXT_PUBLIC_RUNTIME_UI",
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};
    for (const key of envKeys) savedEnv[key] = process.env[key];
    // Resolve the real passwd home (test-preload.ts already isolated process.env.HOME).
    const operatorHome = passwdHomeDir();

    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-agy-real-e2e-"));
    const tempHome = path.join(sandbox, "home");
    const xdgConfig = path.join(sandbox, "xdg-config");
    const xdgCache = path.join(sandbox, "xdg-cache");
    const xdgData = path.join(sandbox, "xdg-data");
    const xdgState = path.join(sandbox, "xdg-state");
    const stateDir = path.join(xdgConfig, "agent-log-viewer", "state");
    const tmpDir = path.join(sandbox, "tmp");
    const cwd = path.join(sandbox, "work");

    // Kernel-enforced read-only filesystem outside `sandbox` for the entire agy process tree.
    const confinedSpawnProcess = assertAndCreateBwrapSpawner(sandbox, operatorHome);

    let liveHost: import("@/lib/runtime/antigravityAcpHost").AntigravityAcpHost | null = null;
    let store: import("@/lib/agent/registry").AgentRegistry | null = null;
    let journal: import("@/runtime-host/journal").RuntimeJournal | null = null;
    let trackedPids = new Set<number>();
    const copiedLoginPaths: string[] = [];

    try {
      for (const dir of [tempHome, xdgConfig, xdgCache, xdgData, xdgState, stateDir, tmpDir, cwd]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      // Copy the operator's current agy login metadata read-only into temp HOME/XDG.
      const loginRelPaths = [
        ".config/antigravity/credential-user-scope",
        ".gemini/oauth_creds.json",
        ".gemini/google_accounts.json",
      ];
      for (const rel of loginRelPaths) {
        const src = path.join(operatorHome, rel);
        const dstHome = path.join(tempHome, rel);
        if (copyLoginFileReadOnly(src, dstHome)) copiedLoginPaths.push(dstHome);
        if (rel.startsWith(".config/")) {
          const dstXdg = path.join(xdgConfig, rel.slice(".config/".length));
          if (copyLoginFileReadOnly(src, dstXdg)) copiedLoginPaths.push(dstXdg);
        }
      }
      expect(copiedLoginPaths.length).toBeGreaterThan(0);

      process.env.HOME = tempHome;
      process.env.XDG_CONFIG_HOME = xdgConfig;
      process.env.XDG_CACHE_HOME = xdgCache;
      process.env.XDG_DATA_HOME = xdgData;
      process.env.XDG_STATE_HOME = xdgState;
      process.env.LLV_STATE_DIR = stateDir;
      process.env.LLV_STATE_OWNER = "test";
      process.env.TMPDIR = tmpDir;
      process.env.TMP = tmpDir;
      process.env.TEMP = tmpDir;
      process.env.LLV_SPAWN_TRANSPORT = "structured";
      process.env.LLV_STRUCTURED_HOSTS = "1";
      process.env.LLV_RUNTIME_EVENTS = "1";
      process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "unused-runtime.sock");
      process.env.NEXT_PUBLIC_RUNTIME_UI = "1";

      const { GET: getRoles, PUT: putRoles } = await import("@/app/api/roles/route");
      const { POST: postSpawn } = await import("./route");
      const { AgentRegistry } = await import("@/lib/agent/registry");
      const { antigravityAccountForSpawn } = await import("@/lib/accounts/antigravity");
      const { antigravityNativeHome, AntigravityAcpHost } = await import("@/lib/runtime/antigravityAcpHost");
      const { FileRuntimeEventStore } = await import("@/lib/runtime/eventStore");
      const { spawnStructuredConversation, startAntigravityStructuredHost } = await import("@/lib/runtime/structuredSpawn");
      const { RuntimeJournal } = await import("@/runtime-host/journal");

      // 1. In-process GET & PUT /api/roles
      const tRoles = performance.now();
      const getRolesRes = await getRoles();
      expect(getRolesRes.status).toBe(200);
      const rolesPayload = await getRolesRes.json() as {
        launchChoices: Array<{ engine: string; models: Array<{ id: string; efforts: string[] }> }>;
        roles: Array<{ id: string; config: { engine: string; model: string; effort: string } }>;
      };
      const agChoice = rolesPayload.launchChoices.find((choice) => choice.engine === "antigravity");
      expect(agChoice).toBeDefined();
      expect(agChoice!.models.some((m) => m.id === "gemini-3.8-flash" && m.efforts.includes("low"))).toBe(true);

      const putRolesRes = await putRoles(new NextRequest("http://127.0.0.1/api/roles", {
        method: "PUT",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        body: JSON.stringify({
          overrides: {
            builder: { config: { engine: "antigravity", model: "gemini-3.8-flash", effort: "low" } },
          },
        }),
      }));
      expect(putRolesRes.status).toBe(200);
      const getRolesAfter = await (await getRoles()).json() as typeof rolesPayload;
      expect(getRolesAfter.roles.find((role) => role.id === "builder")?.config).toEqual({
        engine: "antigravity",
        model: "gemini-3.8-flash",
        effort: "low",
      });
      mark("rolesMs", tRoles);

      // 2. Seed a previous-release (v1) agent-registry.sqlite, then open it to verify in-place migration.
      const tMigrate = performance.now();
      const registryJsonPath = path.join(stateDir, "agent-registry.json");
      const registrySqlitePath = path.join(stateDir, "agent-registry.sqlite");
      const seedArtifactsDir = path.join(sandbox, "seed-artifacts");
      fs.mkdirSync(seedArtifactsDir, { recursive: true });
      const seedClaude = path.join(seedArtifactsDir, "claude-seed.jsonl");
      const seedCodex = path.join(seedArtifactsDir, "codex-seed.jsonl");
      const seedCopilot = path.join(seedArtifactsDir, "copilot-seed.jsonl");
      for (const file of [seedClaude, seedCodex, seedCopilot]) {
        fs.writeFileSync(file, "{\"type\":\"session.start\"}\n", "utf8");
      }

      const seeder = new AgentRegistry(registryJsonPath, undefined, undefined, {
        sqliteMode: "sqlite",
        sqliteFilename: registrySqlitePath,
      });
      seeder.upsert(makeSeedEntry("claude", "seed-claude", seedClaude));
      seeder.upsert(makeSeedEntry("codex", "seed-codex", seedCodex));
      seeder.upsert(makeSeedEntry("copilot", "seed-copilot", seedCopilot));
      seeder.close();
      downgradeRegistryToV1NativeCallerSchema(registrySqlitePath);

      store = new AgentRegistry(registryJsonPath, undefined, undefined, {
        sqliteMode: "sqlite",
        sqliteFilename: registrySqlitePath,
      });
      expect(Object.keys(store.readOnlySnapshot().entries).sort()).toEqual([
        "claude:seed-claude",
        "codex:seed-codex",
        "copilot:seed-copilot",
      ]);
      mark("registryMigrationMs", tMigrate);

      // 3. In-process RuntimeJournal client (ZERO servers, ZERO network sockets).
      journal = new RuntimeJournal(path.join(sandbox, "runtime-events.sqlite"), {
        structuredHosts: true,
        maxEvents: 500,
      });
      const inProcessClient = {
        command: async (command: RuntimeOperationCommand) => journal!.executeOperation(command),
        transitionOperation: async (
          operationId: string,
          status: Exclude<RuntimeReceiptStatus, "pending">,
          details?: RuntimeTransitionDetails,
          options?: RuntimeTransitionOptions,
        ) => journal!.transitionOperation(operationId, status, details, options),
      } as unknown as RuntimeHostClient;

      // 4. In-process POST /api/spawn with engine=antigravity, model=gemini-3.8-flash-low launching REAL agy acp!
      const tSpawn = performance.now();
      const deferred: Array<() => Promise<void>> = [];
      let spawnLaunchId = "";

      const spawnRes = await postSpawn.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1",
          host: "127.0.0.1",
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          title: "Real Antigravity E2E",
          engine: "antigravity",
          model: "gemini-3.8-flash-low",
          cwd,
          ["prompt"]: "Reply with exactly the single token: FIRST_OK",
          clientAttemptId: `ag_real_e2e_${crypto.randomUUID().slice(0, 8)}`,
        }),
      }), {
        registry: () => store!,
        assertStructuredRuntime: () => {},
        storeImages: () => [],
        resolveHealthySpawnAccount: async (_engine, requested) => antigravityAccountForSpawn(requested),
        resolveSpawnAccount: (_engine, requested) => antigravityAccountForSpawn(requested),
        resolvePinnedSpawnAdmission: async () => ({
          kind: "admissible",
          basis: "current",
          stale: false,
          retryAt: null,
        }),
        runtimeHostClient: () => inProcessClient,
        defer: (work) => { deferred.push(work); },
        spawnStructuredConversation: async (input) => {
          spawnLaunchId = input.receipt.launchId;
          return await spawnStructuredConversation(input, {
            durableSetupTimeoutMs: 60_000,
            startHost: async (spawnInput, capability) => {
              const host = await startAntigravityStructuredHost(spawnInput, capability, {
                viewerMcpServer: null,
                mcpServers: [],
                eventStore: new FileRuntimeEventStore(path.join(stateDir, "structured-host-events")),
                spawnProcess: confinedSpawnProcess,
                requestTimeoutMs: 45_000,
              });
              liveHost = host;
              const health = await host.health();
              if (health.pid) trackedPids = collectDescendantPids(health.pid);
              return host;
            },
            publishHost: async () => async () => {},
            deliverFirst: async (spawnInput) => {
              if (!liveHost) throw new Error("live Antigravity host was not captured");
              const receipt = await liveHost.send({
                id: `spawn_message_${spawnInput.receipt.launchId}`,
                text: spawnInput.prompt,
              });
              if (receipt.outcome === "rejected") {
                throw new Error(`first Antigravity message rejected: ${receipt.reason}`);
              }
            },
          });
        },
      });

      expect(spawnRes.status).toBe(202);
      expect(deferred).toHaveLength(1);
      await deferred[0]!();
      expect(liveHost).toBeInstanceOf(AntigravityAcpHost);
      const host = liveHost!;
      mark("spawnAndFirstAcceptanceMs", tSpawn);

      // Capture any additional descendants spawned while active.
      const hostStateAfterSpawn = await host.health();
      expect(hostStateAfterSpawn.pid).toBeGreaterThan(0);
      for (const pid of collectDescendantPids(hostStateAfterSpawn.pid!)) trackedPids.add(pid);

      // Wait for the first real agy turn to complete (`assistant.turn_end` -> idle).
      const waitIdle = async (timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const state = await host.health();
          if (state.status === "idle") return;
          if (state.status === "dead" || state.status === "unhosted") {
            throw new Error(`Antigravity host terminated unexpectedly: ${state.status}`);
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`Antigravity turn did not reach idle within ${timeoutMs}ms`);
      };
      await waitIdle(60_000);
      mark("firstTurnCompleteMs", tSpawn);

      // 5. Verify events.jsonl reached assistant.turn_end with the first delivery id.
      expect(host.identity.path.startsWith(sandbox + path.sep)).toBe(true);
      const firstRecords = fs.readFileSync(host.identity.path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
      expect(firstRecords.some((r) => r.type === "session.start")).toBe(true);
      expect(firstRecords.some((r) => r.type === "user.message" && r.data.entryId === `spawn_message_${spawnLaunchId}`)).toBe(true);
      expect(firstRecords.some((r) => r.type === "assistant.turn_start")).toBe(true);
      expect(firstRecords.some((r) => r.type === "assistant.message" && typeof r.data.content === "string" && r.data.content.length > 0)).toBe(true);
      expect(firstRecords.some((r) => r.type === "assistant.turn_end" && r.data.stopReason === "end_turn")).toBe(true);

      // 6. Verify agent-registry.sqlite recorded antigravity-acp on the migrated schema (and rollback index survives).
      const entryKey = `antigravity:${host.identity.sessionId}`;
      const regEntry = store.readOnlySnapshot().entries[entryKey];
      expect(regEntry?.structuredHost?.kind).toBe("antigravity-acp");
      expect(regEntry?.artifactPath).toBe(host.identity.path);

      const inspectDb = new Database(registrySqlitePath, { readonly: true });
      try {
        expect(
          inspectDb.query<{ value: string }, []>(
            "SELECT value FROM registry_meta WHERE key='native_caller_artifacts_version'",
          ).get()?.value,
        ).toBe("1");
        expect(
          inspectDb.query<{ value: string }, []>(
            "SELECT value FROM registry_meta WHERE key='native_caller_artifacts_revision'",
          ).get()?.value,
        ).toBe("2");
        const trackedPaths = inspectDb.query<{ path: string }, []>(
          "SELECT path FROM registry_native_host_paths",
        ).all().map((row) => row.path);
        expect(trackedPaths).toContain(host.identity.path);
        expect(trackedPaths).toContain(seedClaude);
        expect(trackedPaths).toContain(seedCodex);
        expect(trackedPaths).toContain(seedCopilot);

        // Verify rollback v1 query still resolves using the preserved v1 index.
        const rollbackPlan = inspectDb.query<{ detail: string }, [string]>(`
          EXPLAIN QUERY PLAN
          SELECT row_key FROM json_each(?) AS alias
          CROSS JOIN registry_rows INDEXED BY registry_caller_native_host_artifact
          WHERE ${PREVIOUS_RELEASE_NATIVE_CALLER_HOST}
            AND json_extract(value_json,'$.artifactPath')=alias.value
        `).all(JSON.stringify([seedClaude]));
        expect(rollbackPlan.some((row) => row.detail.includes("USING INDEX registry_caller_native_host_artifact "))).toBe(true);
      } finally {
        inspectDb.close();
      }

      // 7. Second message: MUST be confirmed ONLY through the Step-2 delivery-bound acceptance fact.
      const tSecond = performance.now();
      const secondDeliveryId = `second_delivery_${crypto.randomUUID().slice(0, 8)}`;
      const unseenDeliveryId = `unseen_delivery_${crypto.randomUUID().slice(0, 8)}`;

      const origReadFileSync = fs.readFileSync;
      let transcriptReadCount = 0;
      fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === host.identity.path) transcriptReadCount += 1;
        return origReadFileSync.apply(fs, args);
      }) as typeof fs.readFileSync;
      try {
        // First delivery is materialized; new delivery MUST be absent despite events.jsonl already having user.message!
        expect(await host.sessionMaterializationEvidence(`spawn_message_${spawnLaunchId}`)).toEqual({ state: "materialized" });
        expect((await host.sessionMaterializationEvidence(secondDeliveryId)).state).toBe("absent");
        expect((await host.sessionMaterializationEvidence(unseenDeliveryId)).state).toBe("absent");

        const secondReceipt = await host.send({
          id: secondDeliveryId,
          text: "Reply with exactly the single token: SECOND_OK",
        });
        expect(secondReceipt.outcome).toBe("turn-started");
        // Immediately after send(), before real agy responds over the network, acceptance is still absent.
        expect((await host.sessionMaterializationEvidence(secondDeliveryId)).state).toBe("absent");

        const acceptDeadline = Date.now() + 60_000;
        let secondState = await host.sessionMaterializationEvidence(secondDeliveryId);
        while (secondState.state === "absent" && Date.now() < acceptDeadline) {
          await new Promise((r) => setTimeout(r, 100));
          secondState = await host.sessionMaterializationEvidence(secondDeliveryId);
        }
        expect(secondState).toEqual({ state: "materialized" });
        // Unseen delivery ID STILL stays absent even after turn 2 is accepted!
        expect((await host.sessionMaterializationEvidence(unseenDeliveryId)).state).toBe("absent");
        expect(transcriptReadCount).toBe(0);
      } finally {
        fs.readFileSync = origReadFileSync;
      }

      await waitIdle(60_000);
      mark("secondTurnMs", tSecond);

      const finalRecords = fs.readFileSync(host.identity.path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
      expect(finalRecords.filter((r) => r.type === "user.message").map((r) => r.data.entryId)).toEqual([
        `spawn_message_${spawnLaunchId}`,
        secondDeliveryId,
      ]);
      expect(finalRecords.filter((r) => r.type === "assistant.turn_end")).toHaveLength(2);

      // 8. Verify native agy state was created inside sandbox (kernel bwrap enforced MS_RDONLY everywhere else).
      const agAccount = antigravityAccountForSpawn();
      const nativeConvDb = path.join(
        antigravityNativeHome(agAccount.home),
        ".gemini",
        "antigravity-cli",
        "conversations",
        `${host.identity.sessionId}.db`,
      );
      expect(nativeConvDb.startsWith(sandbox + path.sep)).toBe(true);
      expect(fs.existsSync(nativeConvDb)).toBe(true);

      // 9. Release and adopt the real session inside bwrap, then verify idempotent resend of secondDeliveryId.
      const tAdopt = performance.now();
      const sessionId = host.identity.sessionId;
      for (const pid of collectDescendantPids(hostStateAfterSpawn.pid!)) trackedPids.add(pid);
      await host.release();
      liveHost = null;

      const eventStore = new FileRuntimeEventStore(path.join(stateDir, "structured-host-events"));
      const adopted = await AntigravityAcpHost.adopt(sessionId, {
        cwd,
        antigravityHome: agAccount.home,
        accountId: agAccount.accountId,
        model: "gemini-3.8-flash-low",
        allowAll: true,
        viewerMcpServer: null,
        mcpServers: [],
        eventStore,
        spawnProcess: confinedSpawnProcess,
        requestTimeoutMs: 45_000,
      });
      liveHost = adopted;
      const adoptedHealth = await adopted.health();
      if (adoptedHealth.pid) for (const pid of collectDescendantPids(adoptedHealth.pid)) trackedPids.add(pid);

      expect(await adopted.sessionMaterializationEvidence(`spawn_message_${spawnLaunchId}`)).toEqual({ state: "materialized" });
      expect(await adopted.sessionMaterializationEvidence(secondDeliveryId)).toEqual({ state: "materialized" });
      expect((await adopted.sessionMaterializationEvidence(unseenDeliveryId)).state).toBe("absent");
      const echoesBeforeRetry = eventStore.load(sessionId)
        .filter((ev) => ev.kind === "item" && ev.deliveryEcho?.operationId === secondDeliveryId).length;
      const resendReceipt = await adopted.send({ id: secondDeliveryId, text: "Reply with exactly the single token: SECOND_OK" });
      expect(resendReceipt.outcome).toBe("turn-started");
      const echoesAfterRetry = eventStore.load(sessionId)
        .filter((ev) => ev.kind === "item" && ev.deliveryEcho?.operationId === secondDeliveryId).length;
      expect(echoesAfterRetry).toBe(echoesBeforeRetry);
      expect(echoesAfterRetry).toBe(1);
      mark("adoptAndIdempotentResendMs", tAdopt);

      // 10. Explicit stop + process cleanup verification before finally deletes temp dir.
      const tCleanup = performance.now();
      await adopted.release();
      liveHost = null;
      await new Promise((r) => setTimeout(r, 100));
      for (const pid of trackedPids) {
        expect(isPidAlive(pid)).toBe(false);
      }
      store.close();
      store = null;
      journal.close();
      journal = null;
      mark("cleanupMs", tCleanup);
      mark("totalMs", t0);
      console.log("[antigravity-e2e] timings_ms:", JSON.stringify(timings));
    } finally {
      if (liveHost) {
        try { await liveHost.release(); } catch { /* best effort */ }
      }
      for (const pid of trackedPids) {
        if (isPidAlive(pid)) {
          try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
          try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
        }
      }
      try { store?.close(); } catch { /* best effort */ }
      try { journal?.close(); } catch { /* best effort */ }
      makeWritableRecursive(sandbox);
      fs.rmSync(sandbox, { recursive: true, force: true });
      for (const key of envKeys) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      // Verify temp directory and copied login files are completely gone.
      expect(fs.existsSync(sandbox)).toBe(false);
      for (const loginCopy of copiedLoginPaths) {
        expect(fs.existsSync(loginCopy)).toBe(false);
      }
    }
  }, 120_000);
});
