import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HOT_STATE_BACKEND } from "@/lib/state/hotStateAuthority";
import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";
import * as sqliteState from "@/lib/state/sqliteStateStore";
import {
  checkpointHotStateRollbackMirrorsForDemotion,
  establishHotStateCutoverBoundary,
  initializeHotStateStoresAtStartup,
} from "@/lib/viewerInstrumentation";

import {
  activeOrchestratorSeats,
  activeOrchestratorSeatsOrUnknown,
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  failOrchestratorSeatIntent,
  orchestratorRevocations,
  orchestratorSeatFor,
  readOrchestratorSeatFile,
  revokedOrchestratorSeatConversationsOrUnknown,
} from "./seats";
import type { OrchestratorSeatFile } from "./seatRecords";
import { importLegacyOrchestratorSeats, ORCHESTRATOR_SEAT_COLLECTION, resetOrchestratorSeatStoreForTests } from "./seatStore";
import { productionShapedSeatRecord, syntheticSeatProject } from "./seatStore.fixture";
import { damageStoredSeatRecord } from "./seatStoreFixture";

const AT = "2026-10-02T00:00:00.000Z";
const CHILD = path.join(import.meta.dir, "seatStore.child.ts");
const saved = { state: process.env.LLV_STATE_DIR, port: process.env.PORT };
let sandbox = "";

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-store-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetOrchestratorSeatStoreForTests();
});

afterEach(() => {
  resetOrchestratorSeatStoreForTests();
  sqliteState.resetStateReadonlyReaderForTests();
  if (saved.state === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = saved.state;
  if (saved.port === undefined) delete process.env.PORT;
  else process.env.PORT = saved.port;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const seatsFile = () => path.join(sandbox, "orchestrator-seats.json");

/** The stored rows, read through a connection of the test's own. */
function storedRows(): { key: string; json: string }[] {
  const db = new Database(path.join(sandbox, "state.sqlite"), { readonly: true });
  try {
    return db.query<{ row_key: string; value_json: string }, [string]>(
      "SELECT row_key, value_json FROM state_rows WHERE collection = ? ORDER BY row_key",
    ).all(ORCHESTRATOR_SEAT_COLLECTION).map((row) => ({ key: row.row_key, json: row.value_json }));
  } finally { db.close(); }
}

function designate(project: string, clientRequestId: string, conversationId: string, mandate = "m"): void {
  beginOrchestratorSeatIntent({ project, mandate, clientRequestId, mode: "existing", conversationId, now: AT });
  expect(completeOrchestratorSeatIntent({ project, clientRequestId, conversationId, path: null, now: AT }).kind).toBe("activated");
}

test("a production-shaped record imports once, verified, and reads back as the legacy reader read it", () => {
  const text = JSON.stringify(productionShapedSeatRecord(), null, 2);
  expect(Buffer.byteLength(text)).toBeGreaterThan(2 * 1024 * 1024);
  fs.writeFileSync(seatsFile(), text);
  // Before the import the record is the legacy file.
  const before = readOrchestratorSeatFile();
  expect(Object.keys(before.seats)).toHaveLength(12);
  expect(before.history).toHaveLength(50);

  const outcome = importLegacyOrchestratorSeats(seatsFile());
  expect(outcome).toMatchObject({ state: "imported", incident: null });
  expect(fs.statSync(seatsFile()).isDirectory()).toBe(true);
  expect(fs.readdirSync(sandbox).filter((name) => name.startsWith("orchestrator-seats.json.imported-"))).toHaveLength(1);
  expect(readOrchestratorSeatFile()).toEqual(before);
  // A second import finds the record and does nothing.
  expect(importLegacyOrchestratorSeats(seatsFile()).state).toBe("already-imported");

  /* Every distinct mandate and role table is stored once: twelve current
     mandates, one pending, five older versions in history, two role tables.
     No other row carries a text. */
  const rows = storedRows();
  const texts = rows.filter((row) => row.key.startsWith("text:"));
  expect(texts).toHaveLength(20);
  const others = rows.filter((row) => !row.key.startsWith("text:"));
  expect(Math.max(...others.map((row) => row.json.length))).toBeLessThan(4096);
  expect(rows.filter((row) => row.key.startsWith("history:"))).toHaveLength(50);
  expect(rows.filter((row) => row.key.startsWith("revocation:"))).toHaveLength(384);
  const storedBytes = rows.reduce((sum, row) => sum + row.json.length, 0);
  expect(storedBytes).toBeLessThan(Buffer.byteLength(text) / 2);
});

test("keyed reads select only the parts a question needs, and an unchanged record reads no row", () => {
  fs.writeFileSync(seatsFile(), JSON.stringify(productionShapedSeatRecord()));
  importLegacyOrchestratorSeats(seatsFile());
  resetOrchestratorSeatStoreForTests();
  const selections = spyOn(sqliteState, "readStateCollectionSelection");
  const seatSelections = () => selections.mock.calls.filter(([, collection]) => collection === ORCHESTRATOR_SEAT_COLLECTION);
  const prefixes = () => seatSelections().flatMap(([, , selection]) => selection.prefixes ?? []);
  try {
    expect(activeOrchestratorSeats()).toHaveLength(12);
    expect(prefixes()).toEqual(["seat:", "pending:", "rollback:"]);
    const project = syntheticSeatProject(0);
    const seat = orchestratorSeatFor(project);
    expect(seat.active?.mandate.length).toBeGreaterThan(29_000);
    expect(seat.history.length).toBeGreaterThan(0);
    expect(seat.history.every((entry) => entry.seat.project === project)).toBe(true);
    // The project's question adds the history; nothing reads revocations or lineage.
    expect(new Set(prefixes())).toEqual(new Set(["seat:", "pending:", "rollback:", "history:"]));

    const settled = seatSelections().length;
    for (let index = 0; index < 100; index += 1) {
      activeOrchestratorSeats();
      orchestratorSeatFor(syntheticSeatProject(index % 12));
    }
    expect(seatSelections()).toHaveLength(settled);

    /* A write moves the revision, and the next read selects again. */
    failOrchestratorSeatIntent(syntheticSeatProject(1), "request-1-1100", "replaced by the test", AT);
    const afterWrite = seatSelections().length;
    expect(orchestratorSeatFor(syntheticSeatProject(1)).pending).toBeNull();
    expect(seatSelections().length).toBeGreaterThan(afterWrite);
    expect(prefixes().some((prefix) => prefix === "revocation:" || prefix === "lineage:")).toBe(true);
  } finally { selections.mockRestore(); }
});

test("history and seats share one row per distinct text, and a text nothing names is removed", () => {
  for (let index = 0; index < 5; index += 1) {
    beginOrchestratorSeatIntent({ project: "proj-a", mandate: "the same long mandate", clientRequestId: `try-${index}`, mode: "spawn", now: AT });
    failOrchestratorSeatIntent("proj-a", `try-${index}`, "spawn failed", AT);
  }
  const texts = () => storedRows().filter((row) => row.key.startsWith("text:"));
  expect(orchestratorSeatFor("proj-a").history.map((entry) => entry.seat.mandate)).toEqual(Array(5).fill("the same long mandate"));
  expect(texts()).toHaveLength(1);

  designate("proj-b", "first", "conversation_first", "mandate one");
  designate("proj-b", "second", "conversation_second", "mandate two");
  /* The first mandate went with its seat: a revocation keeps no mandate. */
  expect(texts().map((row) => JSON.parse(row.json).value).sort()).toEqual(["mandate two", "the same long mandate"]);
});

test("a write in one process is read by another through its own connection, and back", () => {
  designate("shared", "parent", "conversation_parent");
  const run = (...args: string[]) => {
    const child = Bun.spawnSync([process.execPath, CHILD, ...args], { env: { ...process.env, LLV_STATE_DIR: sandbox }, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return JSON.parse(child.stdout.toString().trim()) as unknown;
  };
  expect(run("read", "shared")).toMatchObject({ active: { conversationId: "conversation_parent", mandate: "m" } });

  // This process holds a snapshot of the record; the child's write moves past it.
  expect(orchestratorSeatFor("shared").active?.conversationId).toBe("conversation_parent");
  expect(run("designate", "shared", "conversation_child")).toBe("activated");
  expect(orchestratorSeatFor("shared").active).toMatchObject({ conversationId: "conversation_child", predecessorConversationId: "conversation_parent" });
  expect(orchestratorRevocations()).toEqual([expect.objectContaining({ conversationId: "conversation_parent", successorConversationId: "conversation_child" })]);
});

test("a damaged stored record reads as unknown until the next designation rewrites it", () => {
  designate("proj-a", "first", "conversation_a");
  designate("proj-a", "second", "conversation_a2");
  expect(orchestratorRevocations()).toHaveLength(1);
  damageStoredSeatRecord();
  resetOrchestratorSeatStoreForTests();
  // A reader that asks for revocations alone still learns the record is not established.
  expect(orchestratorRevocations()).toEqual([]);
  expect(revokedOrchestratorSeatConversationsOrUnknown()).toBeNull();
  expect(activeOrchestratorSeatsOrUnknown()).toBeNull();
  expect(activeOrchestratorSeats()).toEqual([]);
  designate("proj-b", "second", "conversation_b");
  expect(activeOrchestratorSeatsOrUnknown()?.map((seat) => seat.conversationId)).toEqual(["conversation_b"]);
});

test("a store read that fails answers unknown to the guarded readers and empty to authority, and the next read recovers", () => {
  designate("proj-a", "first", "conversation_a");
  resetOrchestratorSeatStoreForTests();
  const failing = spyOn(sqliteState, "readStateCollectionSelection").mockImplementation(() => { throw new Error("disk I/O error"); });
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(activeOrchestratorSeatsOrUnknown()).toBeNull();
    expect(activeOrchestratorSeats()).toEqual([]);
    expect(orchestratorSeatFor("proj-a").active).toBeNull();
  } finally { failing.mockRestore(); quiet.mockRestore(); }
  expect(activeOrchestratorSeatsOrUnknown()?.map((seat) => seat.conversationId)).toEqual(["conversation_a"]);
});

/* The release path (#1870 §6.4): an unpromoted release reads the legacy file
   and refuses writes, the activation imports, the demotion checkpoint writes
   the rollback mirror, and what the older release changes in that file folds
   back in at roll-forward. */
async function activate(revision: string, port: string): Promise<void> {
  process.env.PORT = port;
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    revision,
    hotStateBackend: HOT_STATE_BACKEND,
  }));
  const boundary = await establishHotStateCutoverBoundary(() => true, {
    pollMs: 0,
    stablePolls: 1,
    maxPolls: 2,
    schedule: (callback) => { callback(); return { unref() {} }; },
  });
  await initializeHotStateStoresAtStartup(boundary);
}

function legacySeat(project: string, epoch: number, state: "active" | "pending", conversationId: string | null) {
  return {
    project, seatEpoch: epoch, conversationId, path: null, mandate: `mandate ${project} ${epoch}`, promptVersion: null,
    predecessorConversationId: null, state, intent: { clientRequestId: `legacy-${project}-${epoch}`, mode: "existing", launchId: null, error: null },
    designatedAt: AT, activatedAt: state === "active" ? AT : null,
  };
}

test("the rollback mirror carries the record to an older release, and its edits fold back in at roll-forward", async () => {
  const revision = "4".repeat(40);
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({ endpoint: "http://127.0.0.1:19081", revision, hotStateBackend: HOT_STATE_BACKEND }));
  process.env.PORT = "19081";
  fs.writeFileSync(seatsFile(), JSON.stringify({
    schemaVersion: 1, nextSeatEpoch: 3,
    seats: { alpha: legacySeat("alpha", 1, "active", "conversation_alpha") },
    pending: { beta: legacySeat("beta", 2, "pending", "conversation_beta") },
    revocations: [], history: [],
  }));

  // Unpromoted: the file is the record, and a write waits for promotion.
  expect(orchestratorSeatFor("beta").pending?.conversationId).toBe("conversation_beta");
  expect(() => beginOrchestratorSeatIntent({ project: "gamma", mandate: "m", clientRequestId: "early", mode: "spawn", now: AT })).toThrow("waiting for release promotion");
  expect(fs.statSync(seatsFile()).isFile()).toBe(true);

  await activate(revision, "19081");
  expect((await ensureLegacyCollectionsImported()).get(ORCHESTRATOR_SEAT_COLLECTION)).toMatchObject({ state: "imported" });
  expect(fs.statSync(seatsFile()).isDirectory()).toBe(true);
  designate("gamma", "after-import", "conversation_gamma");

  await checkpointHotStateRollbackMirrorsForDemotion();
  const mirror = JSON.parse(fs.readFileSync(seatsFile(), "utf8")) as OrchestratorSeatFile;
  expect(Object.keys(mirror.seats).sort()).toEqual(["alpha", "gamma"]);
  expect(mirror.pending.beta!.conversationId).toBe("conversation_beta");
  expect(mirror.seats.gamma!.mandate).toBe("m");

  // An untouched mirror is recognized at roll-forward and retired.
  expect((await ensureLegacyCollectionsImported()).get(ORCHESTRATOR_SEAT_COLLECTION)).toMatchObject({ state: "already-imported", incident: null });
  expect(fs.statSync(seatsFile()).isDirectory()).toBe(true);

  /* Demoted again, the older release activates beta's pending intent, which
     revokes nobody, and rotates alpha: it rewrites the whole file the way it
     always did, carrying every lineage entry it read. */
  await checkpointHotStateRollbackMirrorsForDemotion();
  const older = JSON.parse(fs.readFileSync(seatsFile(), "utf8")) as OrchestratorSeatFile;
  older.seats.beta = { ...older.pending.beta!, state: "active", activatedAt: AT };
  delete older.pending.beta;
  older.revocations.push({ project: "alpha", conversationId: "conversation_alpha", seatEpoch: 1, revokedAt: AT, successorConversationId: "conversation_alpha_2" });
  older.seats.alpha = { ...older.seats.alpha!, seatEpoch: older.nextSeatEpoch, conversationId: "conversation_alpha_2", predecessorConversationId: "conversation_alpha" };
  older.nextSeatEpoch += 1;
  fs.writeFileSync(seatsFile(), JSON.stringify(older));

  const rolledForward = (await ensureLegacyCollectionsImported()).get(ORCHESTRATOR_SEAT_COLLECTION);
  expect(rolledForward).toMatchObject({ state: "already-imported", incident: { kind: "legacy-reconciled" } });
  expect(fs.statSync(seatsFile()).isDirectory()).toBe(true);
  expect(orchestratorSeatFor("beta")).toMatchObject({ active: { conversationId: "conversation_beta", state: "active" }, pending: null });
  expect(orchestratorSeatFor("alpha").active?.conversationId).toBe("conversation_alpha_2");
  expect(orchestratorSeatFor("gamma").active?.conversationId).toBe("conversation_gamma");
  expect(orchestratorRevocations().map((row) => row.conversationId)).toEqual(["conversation_alpha"]);
  // The epoch counter never runs backwards past what the older release issued.
  expect(readOrchestratorSeatFile().nextSeatEpoch).toBe(older.nextSeatEpoch);
});

test("a legacy file that does not descend from the recorded mirror removes nothing", async () => {
  const revision = "3".repeat(40);
  fs.writeFileSync(seatsFile(), JSON.stringify({
    schemaVersion: 1, nextSeatEpoch: 2,
    seats: {}, pending: { beta: legacySeat("beta", 1, "pending", "conversation_beta") }, revocations: [], history: [],
  }));
  await activate(revision, "19082");
  await ensureLegacyCollectionsImported();
  await checkpointHotStateRollbackMirrorsForDemotion();
  /* A file an older writer made from nothing (it found the path empty): no
     marker, so the pending intent it lacks is spared, and its own seat joins. */
  fs.writeFileSync(seatsFile(), JSON.stringify({
    schemaVersion: 1, nextSeatEpoch: 3,
    seats: { delta: legacySeat("delta", 2, "active", "conversation_delta") }, pending: {}, revocations: [], history: [],
  }));
  const outcome = (await ensureLegacyCollectionsImported()).get(ORCHESTRATOR_SEAT_COLLECTION);
  expect(outcome).toMatchObject({ incident: { kind: "legacy-reconciled", summary: { added: expect.any(Number), removed: 0 } } });
  expect(orchestratorSeatFor("beta").pending?.conversationId).toBe("conversation_beta");
  expect(orchestratorSeatFor("delta").active?.conversationId).toBe("conversation_delta");
});
