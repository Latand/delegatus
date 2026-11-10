import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { conversationDeliverabilityFromRecord } from "@/lib/conversation/deliverability";
import { RuntimeJournal } from "@/runtime-host/journal";

import { AgentRegistry, normalizeRegistry } from "./registry";
import { structuredHostFixture } from "./registryTestFixtures";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "stored-pane-host-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** The host column of a registry row written while agents ran in terminal
    panes, with synthetic process identities. */
const storedPaneHost = {
  kind: "tmux", endpoint: "fixture-endpoint", server: { pid: 900, startIdentity: "900:fixture" },
  paneId: "%1", panePid: { pid: 901, startIdentity: "901:fixture" }, windowName: "fixture",
  agent: { pid: 902, startIdentity: "902:fixture" }, argv: ["codex"],
};

/** A registry file holding one conversation whose entry is written as given. */
function storedRegistry(name: string, status: string, extra: Record<string, unknown> = {}) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  const seed = new AgentRegistry(path.join(directory, "seed.json"), undefined, undefined, { sqliteMode: "off" });
  const transcript = path.join(directory, "session-one.jsonl");
  const conversation = seed.ensureConversation("codex", transcript, null);
  const generation = conversation.generations.at(-1)!;
  seed.upsert({
    key: { engine: "codex", sessionId: generation.id }, artifactPath: transcript, cwd: directory, accountId: null,
    status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  const stored = JSON.parse(JSON.stringify(seed.snapshot())) as Record<string, Record<string, Record<string, unknown>>>;
  seed.close();
  const key = `codex:${generation.id}`;
  Object.assign(stored.entries![key]!, { host: storedPaneHost, status, ...extra });
  return { directory, stored, key, conversationId: conversation.id, transcript };
}

test("a stored row that names a pane host loads from a JSON registry as unhosted, and delivery to it needs a resume", async () => {
  const f = storedRegistry("json", "live");
  const filename = path.join(f.directory, "registry.json");
  fs.writeFileSync(filename, JSON.stringify(f.stored));
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
  try {
    const snapshot = registry.readOnlySnapshot();
    expect(snapshot.entries[f.key]).toMatchObject({ host: null, status: "unhosted", artifactPath: f.transcript });
    expect(await conversationDeliverabilityFromRecord(snapshot, { conversationId: f.conversationId, transcriptPath: f.transcript }))
      .toMatchObject({ deliverable: false, resumeRequired: true, transport: null });
  } finally { registry.close(); }
});

test("a stored pane-host row in the SQLite registry loads as unhosted through keyed and whole reads", () => {
  const f = storedRegistry("sqlite", "idle");
  const clean = normalizeRegistry(f.stored as never);
  new SqliteAgentRegistryStore(path.join(f.directory, "registry.sqlite"), { initialSnapshot: clean, normalize: normalizeRegistry }).close();
  /* The row as an older release left it: the pane host is in the stored JSON. */
  const database = new Database(path.join(f.directory, "registry.sqlite"));
  const changed = database.query(
    "UPDATE registry_rows SET value_json=json_set(value_json,'$.host',json(?),'$.status','idle') WHERE collection='entries' AND row_key=?",
  ).run(JSON.stringify(storedPaneHost), f.key);
  database.close();
  expect(changed.changes).toBeGreaterThan(0);
  const registry = new AgentRegistry(path.join(f.directory, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  try {
    expect(registry.readOnlySnapshot().entries[f.key]).toMatchObject({ host: null, status: "unhosted" });
    expect(registry.hostEntry({ engine: "codex", sessionId: f.key.slice("codex:".length) })).toMatchObject({ host: null, status: "unhosted" });
  } finally { registry.close(); }
});

test("a stored row that kept structured host columns beside a pane host keeps them and its status; a dead row stays dead", () => {
  const structured = structuredHostFixture({ pid: 903, startIdentity: "903:fixture" }, "codex-app-server");
  const kept = storedRegistry("kept", "idle", { structuredHost: structured });
  expect(normalizeRegistry(kept.stored as never).entries[kept.key]).toMatchObject({ host: null, status: "idle", structuredHost: { kind: "codex-app-server" } });
  const dead = storedRegistry("dead", "dead");
  expect(normalizeRegistry(dead.stored as never).entries[dead.key]).toMatchObject({ host: null, status: "dead" });
});

test("a session journalled for a pane host reads back as unhosted", () => {
  const directory = path.join(root, "journal");
  fs.mkdirSync(directory);
  const filename = path.join(directory, "runtime.sqlite");
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: "conversation_stored" }, kind: "session-status",
    producer: { kind: "structured-delivery-controller", eventKey: "stored-pane-session" },
    payload: {
      conversationId: "conversation_stored", sessionKey: { engine: "codex", sessionId: "session-one" },
      hostKind: "tmux-legacy", host: "hosted", turn: "idle", provenance: "derived",
    },
  } as unknown as Parameters<RuntimeJournal["append"]>[0]);
  journal.close();
  const reopened = new RuntimeJournal(filename, { structuredHosts: true });
  try {
    expect(reopened.snapshot().sessions.find((session) => session.conversationId === "conversation_stored"))
      .toMatchObject({ hostKind: "unhosted" });
  } finally { reopened.close(); }
});
