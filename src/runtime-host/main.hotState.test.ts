import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { HOT_STATE_BACKEND, markHotStateActivationReady, publishHotStateAuthority } from "@/lib/state/hotStateAuthority";

/** A launcher, the child that owes it notices, and the Viewer release file
    the runtime host follows. */
function releaseFixture(directory: string) {
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const launch = (launcher?: ViewerConversationId) => {
    const begun = registry.beginSpawnRequest({
      engine: "codex", cwd: directory, transport: "structured", origin: { kind: "operator" },
      launchProfile: { title: launcher ? "Review the release" : "Coordinate the release" },
      ...(launcher ? { launcher: { conversationId: launcher, notify: true } } : {}),
    });
    if (begun.kind !== "created") throw new Error("fixture launch was refused");
    const settled = registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: begun.receipt.launchId },
      artifactPath: path.join(directory, `${begun.receipt.launchId}.jsonl`), cwd: directory,
      accountId: null, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
    if (settled.kind !== "settled") throw new Error("fixture settlement was refused");
    return settled.conversation.id;
  };
  const launcher = launch();
  const childId = launch(launcher);
  const target = (revision: string) => fs.writeFileSync(path.join(directory, "viewer-release.json"), JSON.stringify({
    revision, endpoint: "http://127.0.0.1:18340", hotStateBackend: HOT_STATE_BACKEND,
  }));
  return { launcher, childId, target };
}

/** Starts the real runtime entry with the image's Viewer identity inherited;
    `stop` ends this child by its own handle. */
function startRuntimeEntry(directory: string, socketPath: string, inherited: Record<string, string | undefined>) {
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith("LLV_") && !key.startsWith("DELEGATUS_")));
  const child = spawn(process.execPath, ["run", "src/runtime-host/main.ts"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...environment, ...inherited, NODE_ENV: "production", LLV_STATE_DIR: directory, LLV_AGENT_REGISTRY_SQLITE: "sqlite",
      LLV_RUNTIME_HOST_SOCKET: socketPath, LLV_VIEWER_DEPLOYMENTS: "0", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return {
    child,
    output: () => output,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (!await Promise.race([exited.then(() => true), Bun.sleep(3_000).then(() => false)])) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}

test.each([
  { PORT: "8898", LLV_STATE_OWNER: "viewer" },
  { LLV_HOT_STATE_RELEASE_REVISION: "a".repeat(40), LLV_STATE_OWNER: "viewer" },
  { PORT: "8898", DELEGATUS_HOT_STATE_RELEASE_REVISION: "a".repeat(40), DELEGATUS_STATE_OWNER: "viewer" },
])("the real runtime host consumes across Viewer releases with inherited identity %j", async (inherited) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-consumer-fence-"));
  const socketPath = path.join(directory, "runtime-host.sock");
  const { launcher, childId, target } = releaseFixture(directory);
  const firstRevision = "b".repeat(40);
  target(firstRevision);
  markHotStateActivationReady(directory, publishHotStateAuthority(directory, "sqlite", firstRevision));

  const host = startRuntimeEntry(directory, socketPath, inherited);
  const { child, output } = host;
  const client = new UnixRuntimeHostClient(socketPath);
  const notice = (turn: string): unknown => {
    const filename = path.join(directory, "state.sqlite");
    if (!fs.existsSync(filename)) return null;
    const db = new Database(filename, { readonly: true });
    try {
      const row = db.query<{ value_json: string }, [string]>(
        "SELECT value_json FROM state_rows WHERE collection = 'spawn_notices' AND row_key = ?",
      ).get(`t:${childId}:${turn}`);
      return row ? JSON.parse(row.value_json) : null;
    } finally { db.close(); }
  };
  const append = (turn: string) => client.append({
    scope: { type: "session", id: childId }, kind: "turn-ended",
    payload: { conversationId: childId, turnId: turn, outcome: "completed" },
    producer: { kind: "codex-app-server", eventKey: `engine-host:fixture:${turn}` },
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(socketPath)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`runtime startup failed: ${output()}`);
      await Bun.sleep(20);
    }
    await append("first");
    expect(notice("first")).toMatchObject({ state: "pending", launcherConversationId: launcher });
    await append("first");

    publishHotStateAuthority(directory, "fencing", firstRevision);
    await append("during-handoff");
    expect(notice("during-handoff")).toBeNull();
    const nextRevision = "c".repeat(40);
    target(nextRevision);
    const activating = publishHotStateAuthority(directory, "sqlite", nextRevision);
    await append("before-activation");
    expect(notice("before-activation")).toBeNull();
    markHotStateActivationReady(directory, activating);
    const replayDeadline = Date.now() + 8_000;
    while (!notice("during-handoff") || !notice("before-activation")) {
      if (Date.now() > replayDeadline) throw new Error(`owed notices did not replay: ${output()}`);
      await Bun.sleep(25);
    }
    expect(notice("during-handoff")).toMatchObject({ state: "pending" });
    expect(notice("before-activation")).toMatchObject({ state: "pending" });
    const db = new Database(path.join(directory, "state.sqlite"), { readonly: true });
    try {
      expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM state_rows WHERE collection = 'spawn_notices'").get()?.count).toBe(3);
    } finally { db.close(); }
  } finally {
    await host.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 25_000);

test("a runtime host restarted inside a release fence keeps serving and delivers what it holds once the next release activates", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-consumer-restart-"));
  const socketPath = path.join(directory, "runtime-host.sock");
  const { childId, target } = releaseFixture(directory);
  const firstRevision = "b".repeat(40);
  target(firstRevision);
  markHotStateActivationReady(directory, publishHotStateAuthority(directory, "sqlite", firstRevision));
  const inherited = { PORT: "8898", LLV_HOT_STATE_RELEASE_REVISION: "a".repeat(40), LLV_STATE_OWNER: "viewer" };

  const client = new UnixRuntimeHostClient(socketPath);
  const hosts: ReturnType<typeof startRuntimeEntry>[] = [];
  /* A restart finds the previous generation's socket file, so listening is
     proved by an answer. */
  const boot = async () => {
    const host = startRuntimeEntry(directory, socketPath, inherited);
    hosts.push(host);
    const deadline = Date.now() + 10_000;
    while (true) {
      if (host.child.exitCode !== null) throw new Error(`runtime host exited ${host.child.exitCode} before listening: ${host.output()}`);
      if (Date.now() > deadline) throw new Error(`runtime host did not listen: ${host.output()}`);
      if (await client.events(0).then(() => true, () => false)) return host;
      await Bun.sleep(25);
    }
  };
  const read = <T>(filename: string, query: (db: Database) => T): T => {
    const db = new Database(path.join(directory, filename), { readonly: true });
    try { return query(db); } finally { db.close(); }
  };
  const notices = () => read("state.sqlite", (db) => db.query<{ row_key: string }, []>(
    "SELECT row_key FROM state_rows WHERE collection = 'spawn_notices' ORDER BY row_key",
  ).all().map((row) => row.row_key));
  /* What the orchestration consumer still owes, read beside the running host. */
  const owed = () => read("runtime-events.sqlite", (db) => db.query<{ kind: string; turn: string | null }, []>(`
    SELECT kind, json_extract(payload_json, '$.turnId') AS turn FROM events
    WHERE seq > COALESCE((SELECT completed_seq FROM consumer_cursors WHERE consumer = 'orchestration'), 0)
      AND NOT EXISTS (SELECT 1 FROM consumer_checkpoints WHERE event_id = events.event_id AND consumer = 'orchestration')
    ORDER BY seq
  `).all());
  const owedTurns = () => owed().filter((event) => event.kind === "turn-ended").map((event) => event.turn);
  const turnEnded = (scope: string, turn: string, payload: Record<string, unknown>) => client.append({
    scope: { type: "session", id: scope }, kind: "turn-ended",
    payload: { turnId: turn, outcome: "completed", ...payload },
    producer: { kind: "codex-app-server", eventKey: `engine-host:fixture:${turn}` },
  });
  const childTurn = (turn: string) => turnEnded(childId, turn, { conversationId: childId });
  const row = (turn: string) => `t:${childId}:${turn}`;
  try {
    const first = await boot();
    await childTurn("before-fence");
    expect(notices()).toEqual([row("before-fence")]);

    publishHotStateAuthority(directory, "fencing", firstRevision);
    /* A flow turn ahead of the notice: its first read of the flows collection
       is a hot-state import, which the fence refuses. */
    await turnEnded("flow-worker", "flow-turn", { conversationId: "flow-worker", flowId: "flow-held", readyNote: "REVIEW_READY: done" });
    await childTurn("held");
    expect(notices()).toEqual([row("before-fence")]);
    await first.stop();

    const fenced = await boot();
    await Bun.sleep(500);
    expect(fenced.child.exitCode).toBeNull();
    expect(owedTurns()).toEqual(["flow-turn", "held"]);
    await childTurn("held");
    expect(owedTurns()).toEqual(["flow-turn", "held"]);
    expect(notices()).toEqual([row("before-fence")]);
    await fenced.stop();

    const nextRevision = "c".repeat(40);
    target(nextRevision);
    markHotStateActivationReady(directory, publishHotStateAuthority(directory, "sqlite", nextRevision));
    await boot();
    /* Boot recovery drains the held events before the socket listens. */
    expect(owed()).toEqual([]);
    expect(notices()).toEqual([row("before-fence"), row("held")]);
    await childTurn("held");
    expect(owed()).toEqual([]);
    expect(notices()).toEqual([row("before-fence"), row("held")]);
  } finally {
    for (const host of hosts) await host.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);
