import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape, type RegistryPerformanceDataset } from "@/lib/agent/registryPerformanceDataset";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { SEND_UNRECORDED_REASON, settleDueSends } from "@/lib/runtime/sendSettlement";

import { deadRecipientDeliveryIds, deliveryEvidenceVerdict, type DeliveryEvidenceInput, type StoredRegistryRow } from "./candidateDeliveryEvidence";
import { RuntimeHost } from "./host";
import { RuntimeJournal } from "./journal";
import { serveRuntimeHost } from "./socket";

/* The candidate performance gate's delivery evidence over the synthetic
   registry it seeds, after the production settlement sweep has run over it
   with the candidate's own runtime host. Since the sweep compares a dead
   recipient's deadline with the same clock sample (#4432), it ends every open
   delivery whose recipient is proven dead, as delivery-terminal-waits.md
   requires; the gate refused every candidate for that write. */

let root = "";
let dataset: RegistryPerformanceDataset;
let openIds: string[] = [];
let retainedIds: string[] = [];
let launchIds: string[] = [];
let deadIds = new Set<string>();
let before: { deliveries: Map<string, StoredRegistryRow>; launches: Map<string, StoredRegistryRow> };
let after: { deliveries: Map<string, StoredRegistryRow>; launches: Map<string, StoredRegistryRow> };

function rowsOf(db: Database, collection: string, keys: readonly string[]): Map<string, StoredRegistryRow> {
  const query = db.query<{ value_json: string; cold: number }, [string, string, string, string]>(
    `SELECT value_json, EXISTS (SELECT 1 FROM registry_cold c WHERE c.collection=? AND c.row_key=?) AS cold
      FROM registry_records WHERE collection=? AND row_key=?`);
  return new Map(keys.flatMap((key) => {
    const row = query.get(collection, key, collection, key);
    return row ? [[key, { json: row.value_json, cold: row.cold === 1 }] as const] : [];
  }));
}

function read(): typeof before {
  const db = new Database(dataset.filename, { readonly: true });
  try {
    return { deliveries: rowsOf(db, "heldDeliveries", retainedIds), launches: rowsOf(db, "receipts", launchIds) };
  } finally {
    db.close();
  }
}

function input(overrides: Partial<DeliveryEvidenceInput> = {}): DeliveryEvidenceInput {
  return {
    openIds, retainedIds, launchIds, deadRecipientIds: deadIds,
    deliveriesBefore: before.deliveries, deliveriesAfter: after.deliveries,
    launchesBefore: before.launches, launchesAfter: after.launches,
    ...overrides,
  };
}

/** The settled rows with one row's stored JSON replaced. */
function editedRow(id: string, edit: (row: Record<string, unknown>) => void, cold?: boolean): Map<string, StoredRegistryRow> {
  const rows = new Map(after.deliveries);
  const current = rows.get(id)!;
  const row = JSON.parse(current.json) as Record<string, unknown>;
  edit(row);
  rows.set(id, { json: JSON.stringify(row), cold: cold ?? current.cold });
  return rows;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-evidence-"));
  dataset = buildRegistryPerformanceDataset(path.join(root, "state"), scaledRegistryPerformanceShape(0.02),
    { sessionsRoot: path.join(root, "sessions") });
  openIds = [...dataset.pendingDeliveryIds, ...dataset.uncertainDeliveryIds];
  /* The dataset addresses every open delivery to an old, dead conversation.
     Two pending and two uncertain ones are addressed to a live worker's
     conversation instead, written as the store updates an existing hot row,
     before any registry opens. */
  const seed = new Database(dataset.filename);
  const living = (seed.query<{ id: string }, [string]>("SELECT row_key AS id FROM registry_records WHERE collection='conversations' AND json_extract(value_json,'$.generations[#-1].id')=?").get(dataset.workers[0]!.sessionId))!.id;
  for (const id of [...dataset.pendingDeliveryIds.slice(0, 2), ...dataset.uncertainDeliveryIds.slice(0, 2)]) {
    seed.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.conversationId',?) WHERE collection='heldDeliveries' AND row_key=?").run(living, id);
    const stored = seed.query<{ id: string }, [string]>("SELECT json_extract(value_json,'$.conversationId') AS id FROM registry_records WHERE collection='heldDeliveries' AND row_key=?").get(id);
    if (stored?.id !== living) throw new Error(`open delivery ${id} is not a hot row`);
  }
  seed.close();
  const census = new Database(dataset.filename, { readonly: true });
  retainedIds = census.query<{ row_key: string }, []>("SELECT row_key FROM registry_records WHERE collection='heldDeliveries'").all().map(row => row.row_key);
  launchIds = census.query<{ row_key: string }, []>("SELECT row_key FROM registry_records WHERE collection='receipts' AND json_extract(value_json,'$.state')='path-pending'").all().map(row => row.row_key);
  deadIds = deadRecipientDeliveryIds(census, openIds);
  /* One clock for the sweep: a minute after the newest admission, inside every
     ordinary ten-minute window, so only a dead recipient makes a send due. */
  const newest = census.query<{ at: string }, []>("SELECT MAX(json_extract(value_json,'$.createdAt')) AS at FROM registry_records WHERE collection='heldDeliveries'").get()!.at;
  census.close();
  before = read();

  const registry = new AgentRegistry(path.join(path.dirname(dataset.filename), "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true });
  const host = new RuntimeHost(journal);
  const socket = path.join(root, "rt.sock");
  const server = serveRuntimeHost(socket, { handle: (request, options) => host.handle(request, options) });
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    await settleDueSends({
      registry,
      client: new UnixRuntimeHostClient(socket),
      now: () => Date.parse(newest) + 60_000,
      progress: { settle: () => {}, deadline: () => {} },
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    journal.close();
    registry.close();
  }
  after = read();
}, 120_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test("the seeded registry holds open deliveries to dead and to living recipients", () => {
  expect(openIds.length).toBe(24);
  expect(deadIds.size).toBe(20);
  expect(launchIds.length).toBeGreaterThan(0);
});

test("settlement ends exactly the open deliveries whose recipient is dead, and the gate accepts that write", () => {
  for (const id of openIds) {
    const seeded = JSON.parse(before.deliveries.get(id)!.json) as Record<string, unknown>;
    const current = JSON.parse(after.deliveries.get(id)!.json) as Record<string, unknown>;
    if (deadIds.has(id)) expect({ state: current.state, error: current.error }).toEqual({ state: "failed", error: SEND_UNRECORDED_REASON });
    else expect(current).toEqual(seeded);
  }
  /* The comparison the gate made before: byte-identical and hot. */
  const byteIdentical = openIds.every(id => before.deliveries.get(id)?.json === after.deliveries.get(id)?.json && !after.deliveries.get(id)?.cold);
  expect(byteIdentical).toBe(false);
  expect(deliveryEvidenceVerdict(input())).toEqual({ preserved: true, settledOnDeadRecipients: deadIds.size, changed: [] });
});

test("an archived settled row is accepted; an archived row the release left open is not", () => {
  const dead = [...deadIds][0]!;
  const living = openIds.find(id => !deadIds.has(id))!;
  expect(deliveryEvidenceVerdict(input({ deliveriesAfter: editedRow(dead, () => {}, true) })).preserved).toBe(true);
  expect(deliveryEvidenceVerdict(input({ deliveriesAfter: editedRow(living, () => {}, true) })).changed).toEqual([`heldDeliveries/${living}`]);
});

test("any other change to a delivery to a dead recipient is lost evidence", () => {
  const dead = [...deadIds][0]!;
  const cases: Array<(row: Record<string, unknown>) => void> = [
    row => { row.text = "rewritten"; },
    row => { row.attempts = 1; },
    row => { row.error = "a reason settlement never writes"; },
    row => { row.state = "delivered"; row.error = null; },
  ];
  for (const edit of cases) {
    expect(deliveryEvidenceVerdict(input({ deliveriesAfter: editedRow(dead, edit) })).changed).toEqual([`heldDeliveries/${dead}`]);
  }
});

test("the settlement write on a delivery whose recipient was not proven dead is lost evidence", () => {
  const living = openIds.find(id => !deadIds.has(id))!;
  const settled = editedRow(living, row => { row.state = "failed"; row.error = SEND_UNRECORDED_REASON; });
  expect(deliveryEvidenceVerdict(input({ deliveriesAfter: settled })).changed).toEqual([`heldDeliveries/${living}`]);
});

test("a retained delivered row, a pending launch or a missing row may not change", () => {
  const delivered = retainedIds.find(id => !openIds.includes(id))!;
  const failedDelivered = editedRow(delivered, row => { row.state = "failed"; row.error = SEND_UNRECORDED_REASON; });
  expect(deliveryEvidenceVerdict(input({ deliveriesAfter: failedDelivered, deadRecipientIds: new Set([...deadIds, delivered]) })).changed)
    .toEqual([`heldDeliveries/${delivered}`]);
  const launch = launchIds[0]!;
  const launches = new Map(after.launches);
  launches.set(launch, { json: launches.get(launch)!.json.replace("path-pending", "failed"), cold: false });
  expect(deliveryEvidenceVerdict(input({ launchesAfter: launches })).changed).toEqual([`receipts/${launch}`]);
  const dead = [...deadIds][0]!;
  const missing = new Map(after.deliveries);
  missing.delete(dead);
  expect(deliveryEvidenceVerdict(input({ deliveriesAfter: missing })).changed).toEqual([`heldDeliveries/${dead}`]);
});
