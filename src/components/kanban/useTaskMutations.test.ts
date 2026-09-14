import { expect, test } from "bun:test";

import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

import { TaskStatusMutations, type PatchBody, type PatchResult, type TaskMutationPorts } from "./useTaskMutations";

/* The optimistic status controller against scripted ports: no server, no
   state directory, no timers. Every answer the ports give is explicit, so each
   test states exactly which server outcome it exercises. */

const REV = (n: number) => `task-v1:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function task(id: string, status: TaskStatus, revision: number, project = "fixture"): BoardTask {
  return {
    id,
    project,
    text: `Task ${id}`,
    status,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    revision: REV(revision),
  } as BoardTask;
}

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function scripted() {
  const patches: Array<{ id: string; body: PatchBody & { status?: TaskStatus }; answer: Deferred<PatchResult> }> = [];
  const reads: Array<{ id: string; answer: Deferred<BoardTask | null> }> = [];
  let changed = 0;
  const ports: TaskMutationPorts = {
    patch(id, body) {
      const answer = deferred<PatchResult>();
      patches.push({ id, body, answer });
      return answer.promise;
    },
    read(id) {
      const answer = deferred<BoardTask | null>();
      reads.push({ id, answer });
      return answer.promise;
    },
    changed() { changed += 1; },
  };
  return { ports, patches, reads, changed: () => changed };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a move shows at once, is written with the revision guard, and stays until the poll shows it", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const original = task("a", "inbox", 1);
  const done = mutations.move(original, "assigned");
  expect(mutations.statuses().get("a")).toBe("assigned");
  expect(mutations.pending("a")).toBe(true);
  await flush();
  expect(server.patches).toHaveLength(1);
  expect(server.patches[0]!.body).toEqual({ status: "assigned", expectedProject: "fixture", expectedRevision: REV(1) });

  server.patches[0]!.answer.resolve({ ok: true, task: task("a", "assigned", 2) });
  expect((await done).kind).toBe("saved");
  expect(mutations.pending("a")).toBe(false);
  expect(server.changed()).toBe(1);

  /* A poll that has not caught up yet keeps the optimistic column. */
  mutations.reconcile([original]);
  expect(mutations.statuses().get("a")).toBe("assigned");
  /* The poll carrying the confirmed write releases it. */
  mutations.reconcile([task("a", "assigned", 2)]);
  expect(mutations.statuses().has("a")).toBe(false);
});

test("a refused write returns the card to the column it came from", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const done = mutations.move(task("a", "assigned", 1), "done");
  await flush();
  server.patches[0]!.answer.resolve({ ok: false, status: 500, error: "disk full" });
  const outcome = await done;
  expect(outcome).toEqual({ kind: "failed", from: "assigned", to: "done", error: "disk full", status: 500 });
  expect(mutations.statuses().has("a")).toBe(false);
  expect(server.changed()).toBe(0);
});

test("a network failure is a refusal with status 0, never an unhandled rejection", async () => {
  const mutations = new TaskStatusMutations({
    patch: async () => { throw new Error("offline"); },
    read: async () => null,
    changed: () => {},
  });
  const outcome = await mutations.move(task("a", "inbox", 1), "blocked");
  expect(outcome.kind).toBe("failed");
  expect(outcome.kind === "failed" && outcome.status).toBe(0);
  expect(mutations.statuses().has("a")).toBe(false);
});

test("409 when the server already holds the target status: settled without a second write", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const done = mutations.move(task("a", "inbox", 1), "done");
  await flush();
  server.patches[0]!.answer.resolve({ ok: false, status: 409, error: "expectedRevision is stale" });
  await flush();
  server.reads[0]!.answer.resolve(task("a", "done", 7));
  const outcome = await done;
  expect(outcome.kind).toBe("settled");
  expect(server.patches).toHaveLength(1);
  expect(mutations.statuses().get("a")).toBe("done");
  mutations.reconcile([task("a", "done", 7)]);
  expect(mutations.statuses().has("a")).toBe(false);
});

test("409 when only other fields moved: re-sent once with the stored guard", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const done = mutations.move(task("a", "inbox", 1), "assigned");
  await flush();
  server.patches[0]!.answer.resolve({ ok: false, status: 409, error: "expectedRevision is stale" });
  await flush();
  server.reads[0]!.answer.resolve({ ...task("a", "inbox", 4), text: "Renamed elsewhere" } as BoardTask);
  await flush();
  expect(server.patches).toHaveLength(2);
  expect(server.patches[1]!.body).toEqual({ status: "assigned", expectedProject: "fixture", expectedRevision: REV(4) });
  server.patches[1]!.answer.resolve({ ok: true, task: task("a", "assigned", 5) });
  expect((await done).kind).toBe("saved");
});

test("409 from a display-remapped project: the stored project and the same revision are re-sent", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  /* `/api/files` remaps a merged project's name; the store still holds the alias. */
  const done = mutations.move(task("a", "blocked", 3, "merged-display"), "done");
  await flush();
  expect(server.patches[0]!.body.expectedProject).toBe("merged-display");
  server.patches[0]!.answer.resolve({ ok: false, status: 409, error: "expectedProject does not match" });
  await flush();
  server.reads[0]!.answer.resolve(task("a", "blocked", 3, "stored-alias"));
  await flush();
  expect(server.patches[1]!.body).toEqual({ status: "done", expectedProject: "stored-alias", expectedRevision: REV(3) });
  server.patches[1]!.answer.resolve({ ok: true, task: task("a", "done", 4, "stored-alias") });
  expect((await done).kind).toBe("saved");
});

test("409 when the status changed elsewhere: the card follows the server and the operator decides", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const done = mutations.move(task("a", "inbox", 1), "assigned");
  await flush();
  server.patches[0]!.answer.resolve({ ok: false, status: 409, error: "expectedRevision is stale" });
  await flush();
  server.reads[0]!.answer.resolve(task("a", "blocked", 9));
  const outcome = await done;
  expect(outcome).toMatchObject({ kind: "conflict", from: "inbox", to: "assigned", serverStatus: "blocked" });
  expect(server.patches).toHaveLength(1);
  expect(mutations.statuses().get("a")).toBe("blocked");
  /* An older poll does not pull it back; the server's row releases it. */
  mutations.reconcile([task("a", "inbox", 1)]);
  expect(mutations.statuses().get("a")).toBe("blocked");
  mutations.reconcile([task("a", "blocked", 9)]);
  expect(mutations.statuses().has("a")).toBe(false);
});

test("moves of one task queue; the second is guarded by the revision the first returned", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const original = task("a", "inbox", 1);
  const first = mutations.move(original, "assigned");
  const second = mutations.move(original, "done");
  expect(mutations.statuses().get("a")).toBe("done");
  await flush();
  expect(server.patches).toHaveLength(1);
  server.patches[0]!.answer.resolve({ ok: true, task: task("a", "assigned", 2) });
  expect((await first).kind).toBe("saved");
  await flush();
  expect(server.patches).toHaveLength(2);
  expect(server.patches[1]!.body).toEqual({ status: "done", expectedProject: "fixture", expectedRevision: REV(2) });
  expect(mutations.pending("a")).toBe(true);
  server.patches[1]!.answer.resolve({ ok: true, task: task("a", "done", 3) });
  expect((await second).kind).toBe("saved");
  expect(mutations.statuses().get("a")).toBe("done");
  expect(mutations.pending("a")).toBe(false);
});

test("moves of different tasks are written concurrently", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const a = mutations.move(task("a", "inbox", 1), "assigned");
  const b = mutations.move(task("b", "assigned", 1), "blocked");
  await flush();
  expect(server.patches.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
  server.patches.find((entry) => entry.id === "b")!.answer.resolve({ ok: false, status: 500, error: "boom" });
  server.patches.find((entry) => entry.id === "a")!.answer.resolve({ ok: true, task: task("a", "assigned", 2) });
  expect((await a).kind).toBe("saved");
  expect((await b).kind).toBe("failed");
  expect(mutations.statuses().get("a")).toBe("assigned");
  expect(mutations.statuses().has("b")).toBe(false);
});

test("undo is the inverse move through the same guarded path", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const original = task("a", "inbox", 1);
  const moved = mutations.move(original, "done");
  await flush();
  server.patches[0]!.answer.resolve({ ok: true, task: task("a", "done", 2) });
  await moved;
  const undone = mutations.move(original, "inbox");
  expect(mutations.statuses().get("a")).toBe("inbox");
  await flush();
  expect(server.patches[1]!.body).toEqual({ status: "inbox", expectedProject: "fixture", expectedRevision: REV(2) });
  server.patches[1]!.answer.resolve({ ok: true, task: task("a", "inbox", 3) });
  expect((await undone).kind).toBe("saved");
});

test("a move to the column a task already sits in writes nothing", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  expect((await mutations.move(task("a", "done", 1), "done")).kind).toBe("noop");
  expect(server.patches).toHaveLength(0);
});

test("a queued move that fails after an earlier one landed keeps the landed column until the poll shows it", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const original = task("a", "inbox", 1);
  const first = mutations.move(original, "assigned");
  const second = mutations.move(original, "done");
  await flush();
  server.patches[0]!.answer.resolve({ ok: true, task: task("a", "assigned", 2) });
  await first;
  await flush();
  server.patches[1]!.answer.resolve({ ok: false, status: 500, error: "boom" });
  expect((await second).kind).toBe("failed");
  expect(mutations.statuses().get("a")).toBe("assigned");
  mutations.reconcile([original]);
  expect(mutations.statuses().get("a")).toBe("assigned");
  mutations.reconcile([task("a", "assigned", 2)]);
  expect(mutations.statuses().has("a")).toBe(false);
});

test("a newer revision written elsewhere is adopted from the poll, so the next move needs no 409", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const first = mutations.move(task("a", "inbox", 1), "assigned");
  await flush();
  server.patches[0]!.answer.resolve({ ok: true, task: task("a", "assigned", 2) });
  await first;
  /* An agent renames the task: the poll carries revision 3. */
  mutations.reconcile([{ ...task("a", "assigned", 3), text: "Renamed by an agent" } as BoardTask]);
  const second = mutations.move(task("a", "assigned", 3), "done");
  await flush();
  expect(server.patches[1]!.body).toEqual({ status: "done", expectedProject: "fixture", expectedRevision: REV(3) });
  server.patches[1]!.answer.resolve({ ok: true, task: task("a", "done", 4) });
  expect((await second).kind).toBe("saved");
  expect(server.reads).toHaveLength(0);
});

test("a poll older than this device's own write never replaces the revision that write returned", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const first = mutations.move(task("a", "inbox", 1), "assigned");
  await flush();
  server.patches[0]!.answer.resolve({ ok: true, task: task("a", "assigned", 2) });
  await first;
  /* The poll that raced the write still shows revision 1. */
  mutations.reconcile([task("a", "inbox", 1)]);
  const second = mutations.move(task("a", "inbox", 1), "done");
  await flush();
  expect(server.patches[1]!.body.expectedRevision).toBe(REV(2));
  server.patches[1]!.answer.resolve({ ok: true, task: task("a", "done", 3) });
  expect((await second).kind).toBe("saved");
});

test("the guard keeps the stored project when a poll carries a display-remapped one", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const first = mutations.move(task("a", "inbox", 1, "stored-alias"), "assigned");
  await flush();
  server.patches[0]!.answer.resolve({ ok: true, task: task("a", "assigned", 2, "stored-alias") });
  await first;
  mutations.reconcile([task("a", "blocked", 5, "merged-display")]);
  const second = mutations.move(task("a", "blocked", 5, "merged-display"), "done");
  await flush();
  expect(server.patches[1]!.body).toEqual({ status: "done", expectedProject: "stored-alias", expectedRevision: REV(5) });
  server.patches[1]!.answer.resolve({ ok: true, task: task("a", "done", 6, "stored-alias") });
  expect((await second).kind).toBe("saved");
});

/* ── Field edits (#1695 K4b): colour, group hide, text ─────────────────── */

const withFields = (base: BoardTask, extra: Partial<BoardTask>): BoardTask => ({ ...base, ...extra }) as BoardTask;

test("a hide shows at once, is fenced, and stays until the poll carries it", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const original = task("a", "done", 1);
  const done = mutations.edit(original, { field: "hide", value: true });
  expect(mutations.edits().get("a")).toEqual({ hide: true });
  expect(mutations.pending("a")).toBe(true);
  await flush();
  expect(server.patches[0]!.body).toEqual({ hide: true, expectedProject: "fixture", expectedRevision: REV(1) });
  const stored = withFields(task("a", "done", 2), { groupHidden: { at: "2026-09-14T12:00:00.000Z", by: "operator" } });
  server.patches[0]!.answer.resolve({ ok: true, task: stored });
  expect((await done).kind).toBe("saved");
  mutations.reconcile([original]);
  expect(mutations.edits().get("a")).toEqual({ hide: true });
  mutations.reconcile([stored]);
  expect(mutations.edits().has("a")).toBe(false);
});

test("a hide refused because the task holds the seat rolls back at once and is never retried", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const done = mutations.edit(task("a", "assigned", 1), { field: "hide", value: true });
  await flush();
  server.patches[0]!.answer.resolve({ ok: false, status: 409, code: "TASK_HIDE_PROTECTED", error: "holds the seat" });
  expect(await done).toEqual({ kind: "failed", field: "hide", error: "holds the seat", status: 409, code: "TASK_HIDE_PROTECTED" });
  expect(server.reads).toHaveLength(0);
  expect(server.patches).toHaveLength(1);
  expect(mutations.edits().has("a")).toBe(false);
});

test("a colour whose revision went stale is sent once more with the stored guard; clearing sends none", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const done = mutations.edit(withFields(task("a", "inbox", 1), { color: "teal" }), { field: "color", value: null });
  await flush();
  expect(server.patches[0]!.body).toEqual({ color: "none", expectedProject: "fixture", expectedRevision: REV(1) });
  server.patches[0]!.answer.resolve({ ok: false, status: 409, code: "TASK_REVISION_MISMATCH", error: "stale" });
  await flush();
  server.reads[0]!.answer.resolve(withFields(task("a", "blocked", 5), { color: "teal" }));
  await flush();
  expect(server.patches[1]!.body).toEqual({ color: "none", expectedProject: "fixture", expectedRevision: REV(5) });
  server.patches[1]!.answer.resolve({ ok: true, task: task("a", "blocked", 6) });
  expect((await done).kind).toBe("saved");
  expect(mutations.edits().get("a")).toEqual({ color: null });
});

test("a title saved over text an agent changed meanwhile is a conflict carrying their text, and nothing is overwritten", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const done = mutations.edit(task("a", "assigned", 1), { field: "text", value: "Operator title" });
  await flush();
  server.patches[0]!.answer.resolve({ ok: false, status: 409, error: "expectedRevision is stale" });
  await flush();
  server.reads[0]!.answer.resolve(withFields(task("a", "assigned", 3), { text: "Agent title" }));
  const outcome = await done;
  expect(outcome).toMatchObject({ kind: "conflict", field: "text", serverValue: "Agent title" });
  expect(server.patches).toHaveLength(1);
  expect(mutations.edits().get("a")).toEqual({ text: "Agent title" });
});

test("a text save whose stored text is still the one it started from is re-sent once", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const done = mutations.edit(task("a", "assigned", 1), { field: "text", value: "Renamed" });
  await flush();
  server.patches[0]!.answer.resolve({ ok: false, status: 409, error: "expectedRevision is stale" });
  await flush();
  /* Only the status moved elsewhere; the text is still the original. */
  server.reads[0]!.answer.resolve(task("a", "blocked", 4));
  await flush();
  expect(server.patches[1]!.body).toEqual({ text: "Renamed", expectedProject: "fixture", expectedRevision: REV(4) });
  server.patches[1]!.answer.resolve({ ok: true, task: withFields(task("a", "blocked", 5), { text: "Renamed" }) });
  expect((await done).kind).toBe("saved");
});

test("a status move and an edit of the same task queue: the edit is guarded by the revision the move returned", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const original = task("a", "inbox", 1);
  const move = mutations.move(original, "assigned");
  const recolour = mutations.edit(original, { field: "color", value: "sky" });
  await flush();
  expect(server.patches).toHaveLength(1);
  server.patches[0]!.answer.resolve({ ok: true, task: task("a", "assigned", 2) });
  await move;
  await flush();
  expect(server.patches[1]!.body).toEqual({ color: "sky", expectedProject: "fixture", expectedRevision: REV(2) });
  server.patches[1]!.answer.resolve({ ok: true, task: withFields(task("a", "assigned", 3), { color: "sky" }) });
  expect((await recolour).kind).toBe("saved");
});

test("hiding a group that came back is a new hide: it is written, and the old hide on a poll does not settle it", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const old = withFields(task("a", "assigned", 1), { groupHidden: { at: "2026-09-14T09:00:00.000Z", by: "operator", admitted: [] } });
  /* Without `replaces`, a row that has a hide already shows it: nothing to write. */
  expect(await mutations.edit(old, { field: "hide", value: true })).toEqual({ kind: "noop", field: "hide" });
  const done = mutations.edit(old, { field: "hide", value: true, replaces: "2026-09-14T09:00:00.000Z" });
  expect(mutations.edits().get("a")).toEqual({ hide: true });
  await flush();
  expect(server.patches[0]!.body).toEqual({ hide: true, expectedProject: "fixture", expectedRevision: REV(1) });
  const rehidden = withFields(task("a", "assigned", 2), { groupHidden: { at: "2026-09-14T12:00:00.000Z", by: "operator", admitted: [] } });
  server.patches[0]!.answer.resolve({ ok: true, task: rehidden });
  expect((await done).kind).toBe("saved");
  /* A poll still carrying the old hide keeps the new one on screen. */
  mutations.reconcile([old]);
  expect(mutations.edits().get("a")).toEqual({ hide: true });
  mutations.reconcile([rehidden]);
  expect(mutations.edits().has("a")).toBe(false);
});

test("a bulk hide shows every card at once and writes them one task at a time", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const rows = [task("a", "done", 1), task("b", "done", 1), task("c", "done", 1)];
  let previous: Promise<unknown> = Promise.resolve();
  const outcomes = rows.map((row) => {
    const outcome = mutations.edit(row, { field: "hide", value: true }, { after: previous });
    previous = outcome;
    return outcome;
  });
  expect([...mutations.edits().keys()]).toEqual(["a", "b", "c"]);
  await flush();
  expect(server.patches.map((patch) => patch.id)).toEqual(["a"]);
  /* A refusal of one task does not stop the rest. */
  server.patches[0]!.answer.resolve({ ok: false, status: 409, code: "TASK_HIDE_PROTECTED", error: "holds the seat" });
  await flush();
  expect(server.patches.map((patch) => patch.id)).toEqual(["a", "b"]);
  server.patches[1]!.answer.resolve({ ok: true, task: withFields(task("b", "done", 2), { groupHidden: { at: "2026-09-14T12:00:00.000Z", by: "operator" } }) });
  await flush();
  expect(server.patches.map((patch) => patch.id)).toEqual(["a", "b", "c"]);
  server.patches[2]!.answer.resolve({ ok: true, task: withFields(task("c", "done", 2), { groupHidden: { at: "2026-09-14T12:00:00.000Z", by: "operator" } }) });
  expect((await Promise.all(outcomes)).map((outcome) => outcome.kind)).toEqual(["failed", "saved", "saved"]);
  expect([...mutations.edits().keys()]).toEqual(["b", "c"]);
});

/* ── Polls older than this device's own later writes (#1695 K4b review) ── */

const hiddenRow = (id: string, revision: number) => withFields(task(id, "done", revision), { groupHidden: { at: "2026-09-14T12:00:00.000Z", by: "operator", admitted: [] } });

async function answer(server: ReturnType<typeof scripted>, index: number, result: PatchResult) {
  await flush();
  server.patches[index]!.answer.resolve(result);
  await flush();
}

test("hide then Undo: the poll carrying the hide's own revision keeps Undo on screen; the Undo's revision or a newer foreign one releases it", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const original = task("a", "done", 1);
  const hide = mutations.edit(original, { field: "hide", value: true });
  await answer(server, 0, { ok: true, task: hiddenRow("a", 2) });
  await hide;
  const undo = mutations.edit(original, { field: "hide", value: false });
  await answer(server, 1, { ok: true, task: task("a", "done", 3) });
  await undo;
  mutations.reconcile([hiddenRow("a", 2)]);
  expect(mutations.edits().get("a")).toEqual({ hide: false });
  mutations.reconcile([original]);
  expect(mutations.edits().get("a")).toEqual({ hide: false });
  /* A revision nobody on this device wrote is newer: it decides. */
  mutations.reconcile([hiddenRow("a", 9)]);
  expect(mutations.edits().has("a")).toBe(false);
});

test("rename A then rename B: the poll carrying A's revision keeps B", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const original = task("a", "assigned", 1);
  const first = mutations.edit(original, { field: "text", value: "Title A" });
  await answer(server, 0, { ok: true, task: withFields(task("a", "assigned", 2), { text: "Title A" }) });
  await first;
  const second = mutations.edit(original, { field: "text", value: "Title B" });
  await answer(server, 1, { ok: true, task: withFields(task("a", "assigned", 3), { text: "Title B" }) });
  await second;
  expect(server.patches[1]!.body).toMatchObject({ expectedRevision: REV(2) });
  mutations.reconcile([withFields(task("a", "assigned", 2), { text: "Title A" })]);
  expect(mutations.edits().get("a")).toEqual({ text: "Title B" });
  mutations.reconcile([withFields(task("a", "assigned", 3), { text: "Title B" })]);
  expect(mutations.edits().has("a")).toBe(false);
});

test("colour then hide: the colour's poll keeps both the colour and the hide", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const original = task("a", "done", 1);
  const colour = mutations.edit(original, { field: "color", value: "sky" });
  await answer(server, 0, { ok: true, task: withFields(task("a", "done", 2), { color: "sky" }) });
  await colour;
  const hide = mutations.edit(original, { field: "hide", value: true });
  await answer(server, 1, { ok: true, task: withFields(hiddenRow("a", 3), { color: "sky" }) });
  await hide;
  mutations.reconcile([withFields(task("a", "done", 2), { color: "sky" })]);
  expect(mutations.edits().get("a")).toEqual({ color: "sky", hide: true });
  mutations.reconcile([withFields(hiddenRow("a", 3), { color: "sky" })]);
  expect(mutations.edits().has("a")).toBe(false);
});

test("two status moves: the poll carrying the first move's revision keeps the second", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const original = task("a", "inbox", 1);
  const first = mutations.move(original, "assigned");
  await answer(server, 0, { ok: true, task: task("a", "assigned", 2) });
  await first;
  const second = mutations.move(original, "done");
  await answer(server, 1, { ok: true, task: task("a", "done", 3) });
  await second;
  mutations.reconcile([task("a", "assigned", 2)]);
  expect(mutations.statuses().get("a")).toBe("done");
  mutations.reconcile([task("a", "blocked", 7)]);
  expect(mutations.statuses().has("a")).toBe(false);
});

test("a title saved while an agent rewrote only the description is put onto their text and sent once; a moved title is still a conflict", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const original = withFields(task("a", "assigned", 1), { text: "Old title\nOld description" });
  const rebase = (stored: string) => (stored.split("\n", 1)[0] === "Old title" ? `New title${stored.slice(stored.indexOf("\n"))}` : null);
  const done = mutations.edit(original, { field: "text", value: "New title\nOld description", rebase });
  await answer(server, 0, { ok: false, status: 409, code: "TASK_REVISION_MISMATCH", error: "stale" });
  server.reads[0]!.answer.resolve(withFields(task("a", "assigned", 4), { text: "Old title\nAgent description" }));
  await flush();
  expect(server.patches[1]!.body).toEqual({ text: "New title\nAgent description", expectedProject: "fixture", expectedRevision: REV(4) });
  server.patches[1]!.answer.resolve({ ok: true, task: withFields(task("a", "assigned", 5), { text: "New title\nAgent description" }) });
  expect((await done).kind).toBe("saved");
  expect(mutations.edits().get("a")).toEqual({ text: "New title\nAgent description" });
  expect(server.patches).toHaveLength(2);

  const again = mutations.edit(withFields(task("b", "assigned", 1), { text: "Old title" }), { field: "text", value: "Mine", rebase: (stored) => (stored.split("\n", 1)[0] === "Old title" ? "Mine" : null) });
  await answer(server, 2, { ok: false, status: 409, code: "TASK_REVISION_MISMATCH", error: "stale" });
  server.reads[1]!.answer.resolve(withFields(task("b", "assigned", 2), { text: "Agent title" }));
  expect(await again).toMatchObject({ kind: "conflict", serverValue: "Agent title" });
  expect(server.patches).toHaveLength(3);
});

test("a refused Undo of a saved hide keeps the group hidden on screen until a poll says otherwise", async () => {
  const server = scripted();
  const mutations = new TaskStatusMutations(server.ports);
  const original = task("a", "done", 1);
  const hide = mutations.edit(original, { field: "hide", value: true });
  await answer(server, 0, { ok: true, task: hiddenRow("a", 2) });
  await hide;
  const undo = mutations.edit(original, { field: "hide", value: false });
  expect(mutations.edits().get("a")).toEqual({ hide: false });
  await answer(server, 1, { ok: false, status: 500, error: "disk full" });
  expect((await undo).kind).toBe("failed");
  expect(mutations.edits().get("a")).toEqual({ hide: true });
  /* The row from before the hide is older than what the board shows. */
  mutations.reconcile([original]);
  expect(mutations.edits().get("a")).toEqual({ hide: true });
  mutations.reconcile([hiddenRow("a", 2)]);
  expect(mutations.edits().has("a")).toBe(false);

  /* With nothing confirmed before it, a refusal simply rolls back. */
  const colour = mutations.edit(task("b", "inbox", 1), { field: "color", value: "sky" });
  await answer(server, 2, { ok: false, status: 500, error: "disk full" });
  await colour;
  expect(mutations.edits().has("b")).toBe(false);
});
