import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resetLegacyDocumentStoresForTests } from "@/lib/state/legacyDocumentStore";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import * as dismissals from "@/lib/attention/dismissals";
import { operatorDecisions, readPrototypeReviews } from "./read";
import { saveTasks, loadTasks, loadTasksForList, taskFeedSource } from "@/lib/tasks/store";
import { findPrototypeRound, mutatePrototypeRound, withPrototypeState } from "./store";
import { taskForPrototype } from "./world";
import { clearSeatRoundsForTests, insertSeatRound } from "./seatRounds";
import { resetPrototypeDeliveryWorkerForTests, sweepPrototypeDeliveries } from "./deliveryWorker";
import { prototypeWorld } from "./world";
import type { BoardTask } from "@/lib/tasks/types";
import type { PrototypeReviewRound } from "./types";
const state = process.env.LLV_STATE_DIR!;
const at = "2026-10-01T00:00:00.000Z";
const review = "pr_00000000000000000000000000000001";
function tasks(): BoardTask[] {
  return Array.from({ length: 1025 }, (_, n) => ({ id: `task-${n}`, project: "project-fixture", text: "Prototype fixture",
    status: "inbox", placement: "unplaced", createdAt: at, updatedAt: at, attachments: [], assignments: [], workLinks: [],
    ...(n === 1024 ? { prototypeReviews: [{ id: review, taskId: "task-1024", project: "project-fixture",
      title: "Review", createdAt: at, publicationKey: "fixture", inputDigest: "fixture", source: { conversationId: null }, variants: [] } as PrototypeReviewRound] } : {}) }));
}
afterEach(() => { saveTasks([]); clearSeatRoundsForTests(); });

test("warm decision reads skip unrelated dismissals and keep each response detached across peer commits", () => {
  const originalDir = process.env.LLV_STATE_DIR;
  const dir = fs.mkdtempSync(path.join(state, "dismissal-projection-"));
  process.env.LLV_STATE_DIR = dir;
  try {
    const author = { kind: "manager" as const, conversationId: null, role: null, via: { deputy: "first" } };
    const task = tasks().at(-1)!;
    const key = `prototype:${review}`;
    const unrelated = Array.from({ length: 40 }, (_, n) => ({
      subject: `other-${n}`, at, by: author, conversationId: null, path: null,
    }));
    // A path alias wins over an earlier subject with the same lookup key.
    const direct = { kind: "prototype", taskId: task.id, subject: key, at, by: { kind: "operator" } };
    const aliased = { ...direct, subject: "alias-owner", path: key, by: author };
    fs.writeFileSync(path.join(dir, "attention-dismissals.json"), JSON.stringify({
      schemaVersion: 1, revision: 1, updatedAt: at, records: [...unrelated, direct, aliased],
    }));
    const read = () => readPrototypeReviews(task).rounds[0]!.hidden?.by;
    expect(read()).toEqual(author);
    dismissals.importLegacyAttentionDismissals();
    const held = read();
    expect(held).toEqual(author);
    if (held?.kind !== "manager") throw new Error("missing dismissal owner");
    held.via!.deputy = "client edit";

    let unrelatedCopies = 0;
    const clone = globalThis.structuredClone;
    let fresh: ReturnType<typeof read>;
    try {
      globalThis.structuredClone = (value, ...args) => {
        const unrelatedRow = (row: unknown) => (row as { key?: string } | null)?.key === "d:other-0";
        if (unrelatedRow(value) || (Array.isArray(value) && value.some(unrelatedRow)) || (value instanceof Map && value.has("other-0"))) unrelatedCopies++;
        return clone(value, ...args);
      };
      fresh = read();
    } finally { globalThis.structuredClone = clone; }
    expect(fresh).toEqual(author);
    const peer = new SqliteStateCollection<{ key: string; value: unknown }>(path.join(dir, "state.sqlite"), {
      collection: "attention_dismissals", schemaVersion: 1, busyMessage: "busy",
      key: row => row.key, decode: value => value as { key: string; value: unknown }, clone: structuredClone,
    });
    try {
      // Even an ordinary dismissal can shadow a prototype subject through its path.
      peer.boundedPatch(1, tx => tx.put({ key: "d:alias-owner", value: { ...aliased, kind: undefined } }));
      expect(read()).toBeUndefined();
      peer.boundedPatch(1, tx => tx.put({ key: "d:alias-owner", value: { ...aliased, restoredAt: at, restoredBy: { kind: "operator" } } }));
    } finally { peer.close(); }
    expect(read()).toEqual({ kind: "operator" });
    expect(fresh).toEqual(author);
    expect(held.via!.deputy).toBe("client edit");
    expect(unrelatedCopies).toBe(0);
  } finally {
    resetLegacyDocumentStoresForTests();
    if (originalDir === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = originalDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prototype reads never decode unrelated tasks and retain project denial", async () => {
  saveTasks(tasks());
  // A malformed unrelated row catches a collection read even after its cache
  // was warmed; the selected row itself must still validate.
  const db = new Database(path.join(state, "state.sqlite"));
  db.query("UPDATE state_rows SET value_json=json_set(value_json,'$.status','broken') WHERE collection='tasks' AND row_key='t:task-0'").run();
  try {
    for (let n = 0; n < 20; n++) {
      const round = await withPrototypeState(() => findPrototypeRound("task-1024", review));
      expect(round?.id).toBe(review);
      expect(taskForPrototype("task-1024", { conversationId: "conversation_reader", project: "project-fixture" }).id).toBe("task-1024");
    }
    expect(() => taskForPrototype("task-1024", { conversationId: "conversation_reader", project: "other-project" })).toThrow("limited to the caller's project");
    expect(findPrototypeRound("absent", review)).toBeUndefined();
  } finally { db.query("UPDATE state_rows SET value_json=json_set(value_json,'$.status','inbox') WHERE collection='tasks' AND row_key='t:task-0'").run(); db.close(); }
});

test("prototype bookkeeping reads and writes just its row, preserves peers and rolls back refusals", () => {
  saveTasks(tasks());
  const peer = taskFeedSource()!.get("task-0");
  mutatePrototypeRound("task-1024", review, round => { round.telegramPost = { key: review, state: "sent", at }; });
  expect(findPrototypeRound("task-1024", review)?.telegramPost?.state).toBe("sent");
  expect(taskFeedSource()!.get("task-0")).toEqual(peer);
  const held = taskFeedSource()!.get("task-1024");
  expect(() => mutatePrototypeRound("task-1024", review, round => { round.title = "Discarded"; throw new Error("refused"); })).toThrow("refused");
  expect(taskFeedSource()!.get("task-1024")).toEqual(held);
  expect(() => mutatePrototypeRound("task-1024", "pr_missing", () => {})).toThrow("review not found");
  const before = fs.statSync(path.join(state, "state.sqlite")).size;
  mutatePrototypeRound("task-1024", review, () => {});
  expect(taskFeedSource()!.get("task-1024")).toEqual(held);
  expect(fs.statSync(path.join(state, "state.sqlite")).size).toBe(before);
  expect(loadTasks()).toHaveLength(1025);
});


test("duplicate module readers share one immutable task-list owner", async () => {
  saveTasks(tasks());
  const first = loadTasksForList();
  const moduleUrl = new URL("../tasks/store.ts?prototype-reader-copy", import.meta.url).href;
  const duplicate = await import(moduleUrl) as typeof import("@/lib/tasks/store");
  expect(duplicate.loadTasksForList()).toBe(first);
  mutatePrototypeRound("task-1024", review, round => { round.title = "Changed"; });
  expect(duplicate.loadTasksForList()).toBe(loadTasksForList());
  expect(duplicate.loadTasksForList().find(task => task.id === "task-1024")!.prototypeReviews![0]!.title).toBe("Changed");
});

test("a restarted reader observes committed prototype updates without an in-memory cache", () => {
  saveTasks(tasks());
  const read = () => {
    const source = `import { findPrototypeRound } from ${JSON.stringify(new URL("./store.ts", import.meta.url).pathname)}; console.log(findPrototypeRound("task-1024", ${JSON.stringify(review)})?.title);`;
    const child = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(child.exitCode).toBe(0);
    return new TextDecoder().decode(child.stdout).trim();
  };
  expect(read()).toBe("Review");
  mutatePrototypeRound("task-1024", review, round => { round.title = "Committed"; });
  expect(read()).toBe("Committed");
});


test("the seat worker reads sixteen rounds per keyset page", async () => {
  const { seatRoundPage } = await import("./seatRounds");
  for (let n = 0; n < 33; n++) insertSeatRound({ id: `pr_${n.toString(16).padStart(32, "0")}`, taskId: null,
    project: "project-fixture", title: "Seat question", createdAt: at, publicationKey: `seat-${n}`, inputDigest: "fixture",
    source: { conversationId: null }, variants: [] });
  const first = seatRoundPage();
  const second = seatRoundPage(first.at(-1)!.id);
  const third = seatRoundPage(second.at(-1)!.id);
  expect(first).toHaveLength(16); expect(second).toHaveLength(16); expect(third).toHaveLength(1);
  expect(new Set([...first, ...second, ...third].map(round => round.id)).size).toBe(33);
  expect(seatRoundPage(third[0]!.id)).toHaveLength(0);
  expect(() => seatRoundPage("", 17)).toThrow("invalid seat round page limit");
});

test("a rejected seat row does not stop recovery of a later valid round", async () => {
  const bad = "pr_00000000000000000000000000000001";
  const good = "pr_00000000000000000000000000000002";
  const seatRound = (id: string, decision = false): PrototypeReviewRound => ({ id, taskId: null, project: "project-fixture",
    title: "Seat question", createdAt: at, publicationKey: id, inputDigest: "fixture", source: { conversationId: null }, variants: [],
    ...(decision ? { decision: { chosen: [], comment: "", at, delivery: { state: "pending" as const, clientMessageId: id,
      conversationId: "conversation-seat", text: "answer" } } } : {}) });
  insertSeatRound(seatRound(bad));
  insertSeatRound(seatRound(good, true));
  const db = new Database(path.join(state, "state.sqlite"));
  db.query("UPDATE state_rows SET value_json=json_set(value_json,'$.title',7) WHERE collection='seat-decisions' AND row_key=?").run(bad);
  db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='seat-decisions'").run();
  db.close();

  const recovered: string[] = [];
  try {
    await sweepPrototypeDeliveries({ now: () => Date.parse(at), world: { ...prototypeWorld, orchestrator: () => "conversation-seat" }, delivery: {
      recover: async decision => { recovered.push(decision.delivery.clientMessageId); return { state: "pending" }; },
      send: async () => ({ state: "pending" }), retry: async () => ({ state: "pending" }),
    } }, { force: true, limit: 16 });
  } finally {
    const restore = new Database(path.join(state, "state.sqlite"));
    restore.query("UPDATE state_rows SET value_json=json_set(value_json,'$.title','Seat question') WHERE collection='seat-decisions' AND row_key=?").run(bad);
    restore.query("UPDATE state_collections SET revision=revision+1 WHERE collection='seat-decisions'").run();
    restore.close();
    await resetPrototypeDeliveryWorkerForTests();
  }
  expect(recovered).toEqual([good]);
});


test("prototype reads preserve the legacy view before state promotion", () => {
  const directory = fs.mkdtempSync(path.join(state, "prototype-legacy-"));
  try {
    fs.writeFileSync(path.join(directory, "tasks.json"), JSON.stringify({ tasks: tasks() }));
    const source = `
      import { findPrototypeRound } from ${JSON.stringify(new URL("./store.ts", import.meta.url).pathname)};
      import { taskForPrototype } from ${JSON.stringify(new URL("./world.ts", import.meta.url).pathname)};
      import { taskFeedSource } from ${JSON.stringify(new URL("../tasks/store.ts", import.meta.url).pathname)};
      if (taskFeedSource() !== null) throw new Error("import should be refused before promotion");
      const round = findPrototypeRound("task-1024", ${JSON.stringify(review)});
      const task = taskForPrototype("task-1024", { conversationId: null, project: null });
      console.log(JSON.stringify({ review: round?.id, task: task.id }));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", source], {
      env: { ...process.env, LLV_STATE_DIR: directory, NEXT_PHASE: "phase-production-build" },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(new TextDecoder().decode(child.stderr)).toBe("");
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({ review, task: "task-1024" });
    expect(fs.existsSync(path.join(directory, "state.sqlite"))).toBe(false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test.each(["round", "task", "write"])("prototype %s rejects a malformed selected task", operation => {
  saveTasks(tasks());
  const db = new Database(path.join(state, "state.sqlite"));
  const status = (value: string) => {
    db.query("UPDATE state_rows SET value_json=json_set(value_json,'$.status',?),row_revision=row_revision+1 WHERE collection='tasks' AND row_key='t:task-1024'").run(value);
    db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='tasks'").run();
    db.query("INSERT INTO state_changes(collection,revision,row_key,operation) SELECT collection,revision,'t:task-1024','upsert' FROM state_collections WHERE collection='tasks'").run();
  };
  status("broken");
  try {
    const read = operation === "round" ? () => findPrototypeRound("task-1024", review)
      : operation === "task" ? () => taskForPrototype("task-1024", { conversationId: null, project: null })
      : () => mutatePrototypeRound("task-1024", review, () => {});
    expect(read).toThrow("invalid persisted task row");
  } finally { status("inbox"); db.close(); }
});


test("a Decisions response uses one dismissal snapshot for every task and the requested round", () => {
  const source = tasks().at(-1)!;
  const entries = Array.from({ length: 7 }, (_, n) => {
    const id = `fixture-task-${n}`;
    const round = { ...source.prototypeReviews![0]!, id: `pr_${n.toString(16).padStart(32, "0")}`, taskId: id };
    return { ...source, id, prototypeReviews: [round] };
  });
  const spy = spyOn(dismissals, "readExistingPrototypeDismissals");
  try {
    const selected = entries[3]!.prototypeReviews[0]!.id;
    const result = operatorDecisions(source.project, entries, selected);
    expect(result.decisions.map(round => round.id)).toEqual(entries.map(task => task.prototypeReviews[0]!.id));
    expect(result.round?.id).toBe(selected);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});
