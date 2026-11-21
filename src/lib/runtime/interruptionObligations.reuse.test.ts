import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";

import {
  initializeRecipientInterruptionIndex,
  interruptionObligationStore,
  type InterruptionObligationInput,
} from "./interruptionObligations";

let directory = "";

beforeEach(() => {
  setSystemTime(new Date("2026-10-07T00:05:00.000Z"));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-interruption-reuse-"));
});

afterEach(() => {
  setSystemTime();
  fs.rmSync(directory, { recursive: true, force: true });
});

function cutInput(index: number): InterruptionObligationInput {
  return {
    conversationId: `conversation_reuse-${String(index).padStart(3, "0")}`,
    engine: "claude",
    hostKey: `claude:reuse-${index}`,
    path: `/tmp/reuse-fixture/cut-${index}.jsonl`,
    owner: { pid: 4000 + index, startIdentity: `start-${index}` },
    claimEpoch: 1,
    turnRef: `turn-${index}`,
    boundary: "viewer-release:reuse",
    reason: "viewer-release",
    checkpoint: { lastEventKind: "tool-call", lastEventAt: Date.parse("2026-10-07T00:00:00.000Z") },
    seat: null,
    recordedAt: `2026-10-07T00:00:${String(index).padStart(2, "0")}.000Z`,
  };
}

test("sealed list() avoids file-lock churn and repeated per-row opens while tracking updates and retention", async () => {
  const obligations = path.join(directory, "interruption-obligations");
  const store = interruptionObligationStore(obligations);
  const created = Array.from({ length: 32 }, (_, index) => store.record(cutInput(index)).obligation);
  await initializeRecipientInterruptionIndex(obligations);

  // Warm the cached collection handle once.
  expect(store.list().map(row => row.id)).toEqual(created.map(row => row.id));

  // Steady-state list() should neither create lock files nor re-parse all 32 rows.
  let lockOpens = 0;
  let parses = 0;
  const openSync = fs.openSync;
  const parse = JSON.parse;
  const openSpy = spyOn(fs, "openSync").mockImplementation(((target: unknown, ...args: unknown[]) => {
    if (String(target).includes(".write-locks") || String(target).endsWith(".lock")) lockOpens += 1;
    return Reflect.apply(openSync, fs, [target, ...args]);
  }) as typeof openSync);
  const parseSpy = spyOn(JSON, "parse").mockImplementation((text, ...args) => {
    if (typeof text === "string" && text.includes('"boundary":"viewer-release:reuse"')) parses += 1;
    return Reflect.apply(parse, JSON, [text, ...args]);
  });
  try {
    for (let pass = 0; pass < 20; pass += 1) {
      const rows = store.list();
      expect(rows).toHaveLength(32);
    }
  } finally {
    openSpy.mockRestore();
    parseSpy.mockRestore();
  }
  expect(lockOpens).toBe(0);
  expect(parses).toBe(0);

  // Direct canonical SQL updates still invalidate the cached collection via stateEvidenceVersion.
  const first = created[0]!;
  const updated = { ...first, resolution: "external-sql-update" };
  const manifest = JSON.parse(fs.readFileSync(obligations, "utf8")) as { collection: string };
  const db = new Database(path.join(directory, "state.sqlite"));
  try {
    db.query("UPDATE state_rows SET value_json=? WHERE collection=? AND row_key=?")
      .run(JSON.stringify(updated), manifest.collection, first.id);
  } finally {
    db.close();
  }
  expect(store.list().find(row => row.id === first.id)?.resolution).toBe("external-sql-update");

  // Pending journal appends bypass the sealed fast path and get imported cleanly.
  const appended = { ...created[0]!, id: "interruption-continuation-00000000000000000000000000000099", turnRef: "pending-turn" };
  fs.appendFileSync(`${obligations}.pending.jsonl`, `${JSON.stringify(appended)}\n`);
  expect(store.list().some(row => row.id === appended.id)).toBe(true);

  // Expired resolved records fall through to the transactional retention path and are removed.
  store.update(first.id, { state: "delivered", resolvedAt: "2026-09-01T00:00:00.000Z" });
  expect(store.list().some(row => row.id === first.id)).toBe(false);
});

test("sealed lists preserve filename order on timestamp ties and detach returned records", async () => {
  const directoryPath = path.join(directory, "tied-cuts");
  const store = interruptionObligationStore(directoryPath);
  await initializeRecipientInterruptionIndex(directoryPath);
  const at = "2026-10-07T00:00:00.000Z";
  const ids = Array.from({ length: 12 }, (_, i) => store.record({ ...cutInput(i), recordedAt: at }).obligation.id);
  const expected = [...ids].sort();
  expect(ids).not.toEqual(expected);
  const first = store.list();
  expect(first.map(row => row.id)).toEqual(expected);
  first[0]!.checkpoint.lastEventKind = "changed-by-reader";
  expect(store.list()[0]!.checkpoint.lastEventKind).toBe("tool-call");
});
