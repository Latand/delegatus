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

test.each([
  { PORT: "8898", LLV_STATE_OWNER: "viewer" },
  { LLV_HOT_STATE_RELEASE_REVISION: "a".repeat(40), LLV_STATE_OWNER: "viewer" },
  { PORT: "8898", DELEGATUS_HOT_STATE_RELEASE_REVISION: "a".repeat(40), DELEGATUS_STATE_OWNER: "viewer" },
])("the real runtime host consumes across Viewer releases with inherited identity %j", async (inherited) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-consumer-fence-"));
  const socketPath = path.join(directory, "runtime-host.sock");
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
  const firstRevision = "b".repeat(40);
  target(firstRevision);
  markHotStateActivationReady(directory, publishHotStateAuthority(directory, "sqlite", firstRevision));

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
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`runtime startup failed: ${output}`);
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
      if (Date.now() > replayDeadline) throw new Error(`owed notices did not replay: ${output}`);
      await Bun.sleep(25);
    }
    expect(notice("during-handoff")).toMatchObject({ state: "pending" });
    expect(notice("before-activation")).toMatchObject({ state: "pending" });
    const db = new Database(path.join(directory, "state.sqlite"), { readonly: true });
    try {
      expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM state_rows WHERE collection = 'spawn_notices'").get()?.count).toBe(3);
    } finally { db.close(); }
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (!await Promise.race([exited.then(() => true), Bun.sleep(3_000).then(() => false)])) {
      child.kill("SIGKILL");
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 25_000);
