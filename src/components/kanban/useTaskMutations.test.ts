import { expect, test } from "bun:test";

import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

import { TaskStatusMutations, type PatchResult, type TaskMutationPorts } from "./useTaskMutations";

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
  const patches: Array<{ id: string; body: { status: TaskStatus; expectedProject: string; expectedRevision: string }; answer: Deferred<PatchResult> }> = [];
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
