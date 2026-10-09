import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { TaskWithRevision } from "@/lib/tasks/revision";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { deleteTask, patchTask, createTask } from "@/lib/tasks/commands";
import { loadTasks, loadTasksFile, mutateTasksFile, mutateTasks, mutateLinkedTasks, taskFeedSource } from "@/lib/tasks/store";
import { BOARD_TASKS_PER_PROJECT_LIMIT } from "@/lib/tasks/commands";
import { countBoardTasks, DONE_TASK_BOARD_RETENTION_MS } from "@/lib/tasks/boardVisibility";
import { type BoardTask } from "@/lib/tasks/types";
import { readStateCollectionRevision } from "@/lib/state/sqliteStateStore";

import { updateRemoteProjects } from "./boardLinks";
import { linkedContext, runsElsewhere } from "./linked";
import { installPrefix, nextStamp, STAMP_PATTERN } from "./stamp";
import { applyTaskRows, resetRowBudgetsForTests } from "./taskApply";
import { readLogPage, readScanPage, PAGE_BYTES } from "./taskFeed";
import { encodeTask, decodeWireRow, MAX_WIRE_ROW_BYTES, type WireTask } from "./taskWire";
import { tombstoneCollection } from "./tombstones";
import { prototypeReviewReplica } from "@/lib/prototypeReview/model";
import { readPrototypeReviews } from "@/lib/prototypeReview/read";
import type { PrototypeReviewRound } from "@/lib/prototypeReview/types";

const remote = "code.example.test/acme/widget";
const key = projectIdentityFromRemote(`https://${remote}`, "/")!.project;
const SELF = ["0a0a0a0a", "1111", "4111", "8111", "111111111111"].join("-");
const PEER = ["0b0b0b0b", "2222", "4222", "8222", "222222222222"].join("-");
const THIRD = ["0c0c0c0c", "3333", "4333", "8333", "333333333333"].join("-");
const peerLink = { key: `peer:${PEER}`, install: PEER, prefix: installPrefix(PEER), projects: new Set([key]) };
const original = { state: process.env.LLV_STATE_DIR, config: process.env.XDG_CONFIG_HOME };
const roots: string[] = [];

afterEach(() => {
  if (original.state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = original.state;
  if (original.config === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = original.config;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  resetRowBudgetsForTests();
});

/** An install that shares `key` with one linked peer, without any network. */
function linkedInstall(options: { link?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-sync-"));
  roots.push(root);
  const state = path.join(root, "state");
  process.env.LLV_STATE_DIR = state;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  fs.mkdirSync(path.join(state, "links"), { recursive: true });
  fs.writeFileSync(path.join(state, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { [key]: remote } }));
  fs.writeFileSync(path.join(state, "links/self.json"), JSON.stringify({ v: 1, installId: SELF, label: "alpha", publicUrl: null, check: null }));
  fs.writeFileSync(path.join(state, "links/shared.json"), JSON.stringify({ v: 1, all: false, projects: [key] }));
  fs.writeFileSync(path.join(state, "links/peers.json"), JSON.stringify({ v: 1, peers: [{ id: PEER, url: "https://beta.example.test", token: "t".repeat(43), grantId: randomUUID(), install: PEER, label: "beta", store: randomUUID(), state: "active", lastCall: null, error: null }] }));
  const file = path.join(state, "tasks.json");
  mutateTasks(() => ({ tasks: [], result: null }), file);
  if (options.link !== false) updateRemoteProjects(PEER, [{ key, name: "widget" }], randomUUID());
  return { state, file, db: path.join(state, "state.sqlite") };
}

function create(file: string, text: string, project = key, explicit = true): BoardTask {
  return mutateTasks((tasks) => {
    const outcome = createTask(tasks, { project, text, placement: "unplaced" }, [], { explicit });
    if (!outcome.ok) throw new Error(outcome.error);
    return { tasks: outcome.tasks, result: outcome.task };
  }, file);
}

function edit(file: string, id: string, input: Record<string, unknown>): BoardTask {
  return mutateTasks((tasks) => {
    const outcome = patchTask(tasks, id, input, undefined, { explicit: true });
    if (!outcome.ok) throw new Error(outcome.error);
    return { tasks: outcome.tasks, result: outcome.task };
  }, file);
}

const find = (file: string, id: string) => loadTasks(file).find((task) => task.id === id);
const wire = (task: BoardTask) => encodeTask(task, { id: SELF, prefix: installPrefix(SELF) }).row as WireTask;
function peerRow(base: Partial<WireTask> & { id: string }, stampMs: number, prefix = installPrefix(PEER)): WireTask {
  const stamp = `${String(stampMs).padStart(13, "0")}.000.${prefix}`;
  return { project: key, text: "from peer", status: "inbox", placement: "unplaced", machine: PEER,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    s: { text: stamp, status: stamp, look: stamp, place: stamp, links: stamp, machine: stamp, handover: stamp }, ...base };
}

test("prototype metadata is stamped, replicated and preserved across an older peer's text edit", () => {
  const { file } = linkedInstall();
  const local = create(file, "Prototype task");
  const round: PrototypeReviewRound = { id: `pr_${"a".repeat(32)}`, taskId: local.id, project: key, title: "Layout", createdAt: new Date().toISOString(),
    source: { conversationId: null }, publicationKey: "private-key", inputDigest: "private-digest",
    variants: [{ number: 1, name: "Compact", description: "Controls together", frames: [{ caption: "Controls", image: { id: "a".repeat(64), mime: "image/png", bytes: 8 } }], videos: [] }] };
  mutateTasks(tasks => { tasks.find(t => t.id === local.id)!.prototypeReviews = [round]; return { tasks, result: undefined }; }, file);
  const published = find(file, local.id)!;
  expect(published.sync!.s.text! > local.sync!.s.text!).toBe(true);
  const id = randomUUID();
  const replica = prototypeReviewReplica(published)!;
  replica.rounds[0]!.taskId = id;
  const incoming = peerRow({ id, prototypeReviewReplica: replica }, Date.now());
  expect(applyTaskRows([decodeWireRow(incoming)], peerLink, { filePath: file }).changed).toBe(1);
  const received = find(file, id)!;
  expect(received.sync!.o).toBe(peerLink.prefix);
  expect(received.prototypeReviews).toBeUndefined();
  expect(readPrototypeReviews(received)).toMatchObject({ unavailable: "another-installation", waitingReviewId: round.id });
  expect(readPrototypeReviews(received).rounds[0]!.variants[0]!.frames[0]!.image.url).toBeNull();
  expect(JSON.stringify(wire(published))).not.toContain("private-key");
  const legacyEdit = peerRow({ id, text: "Older peer edited the title" }, Date.now() + 100);
  applyTaskRows([legacyEdit], peerLink, { filePath: file });
  expect(find(file, id)!.prototypeReviewReplica).toEqual(replica);
});

test("stamps keep their width and rise strictly: 1 000 quick edits after a stamp 7 minutes ahead roll the counter into ms", () => {
  const now = Date.parse("2026-09-28T10:00:00Z");
  let mark = nextStamp(null, now + 420_000, "bbbbbbbb");
  const seen: string[] = [];
  for (let i = 0; i < 1_000; i++) { mark = nextStamp(mark, now, "aaaaaaaa"); seen.push(mark); }
  expect(seen.every((stamp) => STAMP_PATTERN.test(stamp) && stamp.length === 26)).toBe(true);
  for (let i = 1; i < seen.length; i++) expect(seen[i]! > seen[i - 1]!).toBe(true);
  expect(Number(seen.at(-1)!.slice(0, 13))).toBe(now + 420_000 + 1);
  // A wall clock stepped back never yields a smaller stamp.
  expect(nextStamp(mark, now - 3_600_000, "aaaaaaaa") > mark).toBe(true);
});

test("the stamp step stamps linked tasks only, per changed group, and leaves every other project untouched", () => {
  const { file } = linkedInstall();
  const linkedTask = create(file, "Linked task");
  const other = create(file, "Private project task", "repo-00000000000000000000000000000000");
  expect(linkedTask.machine).toBe(SELF);
  expect(Object.keys(linkedTask.sync!.s).sort()).toEqual(["handover", "links", "look", "machine", "place", "status", "text"]);
  expect(linkedTask.sync!.o).toBe(installPrefix(SELF));
  expect(other.machine).toBeUndefined();
  expect(other.sync).toBeUndefined();
  const before = find(file, linkedTask.id)!.sync!.s;
  const moved = edit(file, linkedTask.id, { status: "blocked" });
  expect(moved.sync!.s.status! > before.status!).toBe(true);
  for (const group of ["text", "look", "place", "links", "machine", "handover"] as const) expect(moved.sync!.s[group]).toBe(before[group]);
  // An assignment-only write is not a group change.
  const assigned = mutateTasks((tasks) => {
    const index = tasks.findIndex((task) => task.id === linkedTask.id);
    tasks[index] = { ...tasks[index]!, assignments: [{ path: "/tmp/x.jsonl", panePid: null, state: "linked", error: null, at: "2026-09-28T00:00:00.000Z" }] };
    return { tasks, result: tasks[index]! };
  }, file);
  expect(assigned.sync!.s).toEqual(moved.sync!.s);
});

test("deleting a linked task writes its tombstone and the project floor in the same commit; a refused write writes neither", () => {
  const { file, db } = linkedInstall();
  const task = create(file, "Goes away");
  const tombstones = tombstoneCollection(db, true)!;
  const tasksBefore = readStateCollectionRevision(db, "tasks")!;
  const graveBefore = readStateCollectionRevision(db, "task_tombstones") ?? 0;
  expect(() => mutateTasks((tasks) => {
    const removed = deleteTask(tasks, task.id);
    if (!removed.ok) throw new Error(removed.error);
    throw new Error("writer refused after deciding");
  }, file)).toThrow("writer refused");
  expect(readStateCollectionRevision(db, "tasks")).toBe(tasksBefore);
  expect(readStateCollectionRevision(db, "task_tombstones") ?? 0).toBe(graveBefore);
  mutateTasks((tasks) => {
    const removed = deleteTask(tasks, task.id);
    if (!removed.ok) throw new Error(removed.error);
    return { tasks: removed.tasks, result: null };
  }, file);
  const tomb = tombstones.get(`g:${task.id}`) as { gone: string; last?: string; o: string } | null;
  expect(tomb?.o).toBe(installPrefix(SELF));
  // `gone` is above every stamp the row held, so `last` is not stored.
  expect(tomb!.last).toBeUndefined();
  expect((tombstones.get(`floor:${key}`) as { floor: string }).floor).toBe(tomb!.gone);
  expect(readStateCollectionRevision(db, "tasks")).toBe(tasksBefore + 1);
  // A later row of the deleted id is dropped whatever its stamp.
  expect(applyTaskRows([peerRow({ id: task.id }, Date.now())], peerLink, { filePath: file }).changed).toBe(0);
  expect(find(file, task.id)).toBeUndefined();
});

test("apply: the larger stamp wins per group, an equal stamp keeps the local value, and a replay or an echo raises no revision", () => {
  const { file, db } = linkedInstall();
  const id = randomUUID();
  const at = Date.now();
  expect(applyTaskRows([peerRow({ id, text: "Peer title", status: "assigned" }, at)], peerLink, { filePath: file }).changed).toBe(1);
  const received = find(file, id)!;
  expect(received.text).toBe("Peer title");
  expect(received.chosen).toBe(true);
  expect(received.machine).toBe(PEER);
  expect(received.sync!.o).toBe(installPrefix(PEER));
  const revision = readStateCollectionRevision(db, "tasks");
  expect(applyTaskRows([peerRow({ id, text: "Peer title", status: "assigned" }, at)], peerLink, { filePath: file }).changed).toBe(0);
  // Same stamp, different value: the local copy stays.
  expect(applyTaskRows([peerRow({ id, text: "Other words", status: "assigned" }, at)], peerLink, { filePath: file }).changed).toBe(0);
  expect(readStateCollectionRevision(db, "tasks")).toBe(revision);
  // Different groups edited on both sides both survive.
  edit(file, id, { color: "sky" });
  const newer = peerRow({ id, text: "Peer title", status: "done" }, at);
  newer.s.status = `${String(at + 5).padStart(13, "0")}.000.${installPrefix(PEER)}`;
  applyTaskRows([newer], peerLink, { filePath: file });
  const merged = find(file, id)!;
  expect(merged.status).toBe("done");
  expect(merged.color).toBe("sky");
  // Local look won, so the merged row differs from what the peer sent and goes back.
  expect(merged.sync!.o).toBe(installPrefix(SELF));
});

test("apply: machine is taken only from the owner's link, a handover must name the sender, and a stamp 2 hours ahead pauses with clock", () => {
  const { file } = linkedInstall();
  const own = create(file, "Runs here");
  const at = Date.now();
  // The peer claims the task with a newer stamp ending in any prefix: dropped.
  const forged = { ...peerRow({ id: own.id, text: own.text }, at + 60_000, installPrefix(SELF)), machine: PEER, handover: { to: THIRD } };
  forged.s.text = own.sync!.s.text!;
  applyTaskRows([forged], peerLink, { filePath: file });
  const after = find(file, own.id)!;
  expect(after.machine).toBe(SELF);
  expect(after.handover).toBeUndefined();
  expect(runsElsewhere(after)).toBeNull();
  // A task the peer runs, sent by the peer that runs it, may be handed on by it.
  const theirs = randomUUID();
  applyTaskRows([peerRow({ id: theirs }, at)], peerLink, { filePath: file });
  expect(runsElsewhere(find(file, theirs)!)?.code).toBe("TASK_RUNS_ELSEWHERE");
  const handed = { ...peerRow({ id: theirs }, at), machine: SELF };
  handed.s.machine = `${String(at + 1).padStart(13, "0")}.000.${installPrefix(PEER)}`;
  applyTaskRows([handed], peerLink, { filePath: file });
  expect(find(file, theirs)!.machine).toBe(SELF);
  // From here on only this machine may move it: the peer's later claim is dropped.
  const back = { ...peerRow({ id: theirs }, at), machine: PEER };
  back.s.machine = `${String(at + 2).padStart(13, "0")}.000.${installPrefix(PEER)}`;
  applyTaskRows([back], peerLink, { filePath: file });
  expect(find(file, theirs)!.machine).toBe(SELF);
  const ahead = applyTaskRows([peerRow({ id: randomUUID() }, Date.now() + 7_200_000)], peerLink, { filePath: file });
  expect(ahead).toEqual({ changed: 0, refused: "clock" });
});

test("shared project text crosses with or without an explicit chosen flag", () => {
  const { file } = linkedInstall();
  const placeholder = create(file, "CANARY-first-prompt secret words", key, false);
  expect(wire(find(file, placeholder.id)!).text).toBe("CANARY-first-prompt secret words");
  const before = find(file, placeholder.id)!.sync!.s.text!;
  edit(file, placeholder.id, { text: "CANARY-first-prompt secret words" });
  const named = find(file, placeholder.id)!;
  expect(named.chosen).toBe(true);
  expect(named.sync!.s.text! > before).toBe(true);
  expect(wire(named).text).toBe("CANARY-first-prompt secret words");
  // Later automatic titles cross under the same project consent.
  mutateTasks((tasks) => {
    const outcome = patchTask(tasks, placeholder.id, { text: "Automatic retitle" });
    if (!outcome.ok) throw new Error(outcome.error);
    return { tasks: outcome.tasks, result: null };
  }, file);
  expect(wire(find(file, placeholder.id)!).text).toBe("Automatic retitle");
});

test("wire bounds: a stored 530 000-character repository is withheld as a stub, and the largest valid row stays under 170 KB", () => {
  const { file } = linkedInstall();
  const task = create(file, "Old link");
  const oversize = mutateTasks((tasks) => {
    const index = tasks.findIndex((row) => row.id === task.id);
    tasks[index] = { ...tasks[index]!, workLinks: [{ repository: `acme/${"r".repeat(530_000)}`, number: 1, kind: "pr", addedAt: "2026-09-28T00:00:00.000Z", addedBy: "operator" }] };
    return { tasks, result: tasks[index]! };
  }, file);
  const encoded = encodeTask(oversize, { id: SELF, prefix: installPrefix(SELF) });
  expect("withheld" in encoded.row).toBe(true);
  expect(encoded.bytes).toBeLessThan(200);
  expect(() => decodeWireRow({ ...peerRow({ id: randomUUID() }, Date.now()), workLinks: [{ repository: `acme/${"r".repeat(101)}`, number: 1, kind: "pr", addedAt: "2026-09-28T00:00:00.000Z", addedBy: "operator" }] })).toThrow();
  const largest: BoardTask = { ...find(file, task.id)!, chosen: true, text: "\u0001".repeat(6_000), details: "\u0001".repeat(20_000),
    workLinks: Array.from({ length: 20 }, (_, index) => ({ repository: `${"o".repeat(39)}/${"r".repeat(100)}`, number: index + 1, kind: "pr" as const, addedAt: "2026-09-28T00:00:00.000Z", addedBy: "operator" as const })) };
  const big = encodeTask(largest, { id: SELF, prefix: installPrefix(SELF) });
  expect("withheld" in big.row).toBe(false);
  expect(big.bytes).toBeLessThanOrEqual(MAX_WIRE_ROW_BYTES);
  expect(big.bytes).toBeLessThan(PAGE_BYTES);
});

test("log and scan exports share the board's strict done expiry and preserve manual board preferences", () => {
  const { file, db } = linkedInstall();
  const self = linkedContext().self!;
  const at = Date.now();
  const recent = edit(file, create(file, "Recent completion").id, { status: "done" });
  const boundary = edit(file, create(file, "Exactly three days").id, { status: "done" });
  const old = edit(file, create(file, "Expired completion").id, { status: "done" });
  const hidden = edit(file, create(file, "Hidden active task").id, { board: "hidden" });
  mutateTasks((tasks) => ({ tasks: tasks.map((task) => ({ ...task,
    ...(task.id === recent.id ? { board: "hidden" as const } : {}),
    ...(task.id === boundary.id ? { doneAt: new Date(at - DONE_TASK_BOARD_RETENTION_MS).toISOString() } : {}),
    ...(task.id === old.id ? { doneAt: new Date(at - DONE_TASK_BOARD_RETENTION_MS - 1).toISOString() } : {}),
  })), result: null }), file);
  const filter = { self, projects: new Set([key]), skipPrefix: installPrefix(PEER), filePath: file };
  const now = spyOn(Date, "now").mockReturnValue(at);
  try {
    const log = readLogPage([0], filter);
    if (log.kind !== "page") throw new Error("resync");
    const expected = [recent.id, boundary.id, hidden.id].sort();
    expect(log.rows.map((row) => row.id).sort()).toEqual(expected);
    expect(log.cursor).toEqual([taskFeedSource(file)!.revision()]);
    expect(readLogPage(log.cursor, filter)).toMatchObject({ rows: [], more: false });
    expect(readScanPage("", filter).rows.map((row) => row.id).sort()).toEqual(expected);
    expect(loadTasks(file)).toHaveLength(4);
    expect(tombstoneCollection(db, false)?.keyRange("g:", "g:\uffff", 10) ?? []).toEqual([]);
  } finally { now.mockRestore(); }
});

test("a transaction of 201 linked tasks pages in two inside one revision, and cap-sized rows split before 200 on the byte bound; nothing repeats or is skipped", () => {
  const { file } = linkedInstall();
  const self = linkedContext().self!;
  const start = taskFeedSource(file)!.revision();
  mutateTasks((tasks) => {
    const next = tasks.slice();
    for (let i = 0; i < 201; i++) {
      const outcome = createTask(next, { project: key, text: `bulk ${i}`, placement: "unplaced", board: "hidden" }, [], { explicit: true });
      if (!outcome.ok) throw new Error(outcome.error);
      next.push(outcome.task);
    }
    return { tasks: next, result: null };
  }, file);
  const filter = { self, projects: new Set([key]), skipPrefix: installPrefix(PEER), filePath: file };
  const first = readLogPage([start], filter);
  if (first.kind !== "page") throw new Error("resync");
  expect(first.rows).toHaveLength(200);
  expect(first.more).toBe(true);
  expect(first.cursor).toHaveLength(2);
  const second = readLogPage(first.cursor, filter);
  if (second.kind !== "page") throw new Error("resync");
  expect(second.rows).toHaveLength(1);
  expect(second.more).toBe(false);
  const ids = [...first.rows, ...second.rows].map((row) => row.id);
  expect(new Set(ids).size).toBe(201);
  // Echo rule: rows whose copy equals the peer's are not served to it.
  const echo = readLogPage([start], { ...filter, skipPrefix: installPrefix(SELF) });
  expect(echo.kind === "page" && echo.rows.length).toBe(0);

  const bigStart = taskFeedSource(file)!.revision();
  mutateTasks((tasks) => {
    const next = tasks.slice();
    for (let i = 0; i < 12; i++) {
      const outcome = createTask(next, { project: key, text: "Ю".repeat(6_000), details: "Ї".repeat(20_000), placement: "unplaced", board: "hidden" }, [], { explicit: true });
      if (!outcome.ok) throw new Error(outcome.error);
      next.push(outcome.task);
    }
    return { tasks: next, result: null };
  }, file);
  const pages: string[][] = [];
  let cursor: [number] | [number, string] = [bigStart];
  for (let guard = 0; guard < 10; guard++) {
    const page = readLogPage(cursor, filter);
    if (page.kind !== "page") throw new Error("resync");
    expect(Buffer.byteLength(JSON.stringify(page.rows))).toBeLessThanOrEqual(PAGE_BYTES);
    pages.push(page.rows.map((row) => row.id));
    cursor = page.cursor;
    if (!page.more) break;
  }
  expect(pages.length).toBeGreaterThan(1);
  expect(new Set(pages.flat()).size).toBe(12);
  expect(pages.flat()).toHaveLength(12);

  // A scan of the project by key reaches every row once as well.
  const scanned: string[] = [];
  let after = "";
  for (let guard = 0; guard < 20; guard++) {
    const page = readScanPage(after, { ...filter, skipPrefix: null });
    scanned.push(...page.rows.map((row) => row.id));
    if (page.next === null) break;
    after = page.next;
  }
  expect(new Set(scanned).size).toBe(213);
});

test("tombstones apply through deleteTask, and a row arriving for a tombstoned id stays dropped", () => {
  const { file } = linkedInstall();
  const id = randomUUID();
  const at = Date.now();
  applyTaskRows([peerRow({ id }, at)], peerLink, { filePath: file });
  const gone = `${String(at + 10).padStart(13, "0")}.000.${installPrefix(PEER)}`;
  expect(applyTaskRows([{ id, project: key, gone }], peerLink, { filePath: file }).changed).toBe(1);
  expect(find(file, id)).toBeUndefined();
  expect(applyTaskRows([peerRow({ id, text: "edit after delete" }, at + 999_999)], peerLink, { filePath: file }).changed).toBe(0);
  expect(find(file, id)).toBeUndefined();
  // The tombstone is served onward from the log, not back to the peer it came from.
  const self = linkedContext().self!;
  const back = readLogPage([0], { self, projects: new Set([key]), skipPrefix: installPrefix(PEER), filePath: file });
  expect(back.kind === "page" && back.rows.some((row) => row.id === id)).toBe(false);
});

test("with no project linked nothing is stamped and no tombstone collection is created", () => {
  const { file, db } = linkedInstall({ link: false });
  const task = create(file, "Shared on one side only");
  expect(task.sync).toBeUndefined();
  mutateLinkedTasks((tasks, sync) => {
    expect(sync).toBeNull();
    return { tasks: tasks.filter((row) => row.id !== task.id), result: null };
  }, file);
  expect(readStateCollectionRevision(db, "task_tombstones")).toBeNull();
});

test("shared admission titles cross while their sources and assignments stay local", async () => {
  const { file } = linkedInstall();
  const { ensureTaskMembership } = await import("@/lib/tasks/membership");
  const made = mutateTasks((tasks) => {
    const launch = ensureTaskMembership(tasks, { project: key, origin: { kind: "launch", key: "attempt-canary" }, title: "CANARY-launch-prompt", identity: { launchId: "launch-canary", conversationId: "conversation_canary" } });
    if (!launch.ok) throw new Error(launch.error);
    const pipeline = ensureTaskMembership(launch.tasks, { project: key, origin: { kind: "pipeline", key: "lane-canary" }, title: "CANARY-pipeline-goal", identity: { launchId: "launch-stage", conversationId: "conversation_stage" }, titled: true });
    if (!pipeline.ok) throw new Error(pipeline.error);
    const curator = createTask(pipeline.tasks, { project: key, text: "CANARY-curator-line", placement: "unplaced", source: { path: "/sessions/x.jsonl", ts: null, text: "CANARY-curator-line", fingerprint: "f", engine: "claude" } });
    if (!curator.ok) throw new Error(curator.error);
    return { tasks: curator.tasks, result: [...launch.created, ...pipeline.created, curator.task.id] };
  }, file);
  expect(made).toHaveLength(3);
  for (const id of made) {
    const row = wire(find(file, id)!);
    expect(row.text).toBe(find(file, id)!.text);
    expect(row).not.toHaveProperty("source");
    expect(row).not.toHaveProperty("assignments");
  }
});

/* The rollback check: a release from before this change reads the same
   database. Its store is taken from the merge base with main and loaded
   beside the current modules. */
const mergeBase = (() => {
  const base = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { encoding: "utf8" });
  if (base.status !== 0) return null;
  const source = spawnSync("git", ["show", `${base.stdout.trim()}:src/lib/tasks/store.ts`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return source.status === 0 && !source.stdout.includes("taskSyncWrite") ? source.stdout : null;
})();
test.skipIf(mergeBase === null)("a release reading the database without the change still loads the task list", async () => {
  const { file } = linkedInstall();
  const kept = create(file, "Kept");
  const gone = create(file, "Deleted");
  mutateTasks((tasks) => {
    const removed = deleteTask(tasks, gone.id);
    if (!removed.ok) throw new Error(removed.error);
    return { tasks: removed.tasks, result: null };
  }, file);
  applyTaskRows([peerRow({ id: randomUUID(), text: "From the peer" }, Date.now())], peerLink, { filePath: file });
  const older = path.join(import.meta.dir, "../tasks", `rollbackStore.${process.pid}.tmp.ts`);
  fs.writeFileSync(older, mergeBase!);
  try {
    const store = await import(older) as typeof import("@/lib/tasks/store");
    const loaded = store.loadTasks(file);
    expect(loaded.map((task) => task.text).sort()).toEqual(["From the peer", "Kept"]);
    expect(loaded.find((task) => task.id === kept.id)?.machine).toBe(SELF);
  } finally {
    fs.rmSync(older, { force: true });
  }
});


test("peer arrivals preserve membership, bound bands, and repair legacy done arrivals once without losing fields", () => {
  const { file, db } = linkedInstall();
  const at = Date.now();
  const legacy = peerRow({ id: randomUUID(), status: "done", details: "Keep the evidence" }, at);
  // The pre-fix receiver stored this shape, with no board field.
  mutateTasks(() => ({ tasks: [{ ...legacy, assignments: [], chosen: true, sync: { s: legacy.s, o: installPrefix(PEER) } }], result: null }), file);
  mutateTasksFile((state) => ({ state: { ...state, recentCreates: [{ clientRequestId: "legacy-arrival-receipt", taskId: legacy.id }] }, result: null }), file);
  const receipts = loadTasksFile(file).recentCreates;
  const before = find(file, legacy.id)!;
  const privateTask = create(file, "Local completed task");
  edit(file, privateTask.id, { status: "done" });
  const done = peerRow({ id: randomUUID(), status: "done" }, at);
  const hidden = peerRow({ id: randomUUID(), board: "hidden" }, at);
  const shown = peerRow({ id: randomUUID(), status: "done", board: "shown" }, at);
  const decode = (row: WireTask) => decodeWireRow(row);
  // Encoding and decoding must carry membership, including hidden open tasks.
  const hiddenWire = encodeTask({ ...before, id: hidden.id, status: "inbox", board: "hidden" }, { id: PEER, prefix: installPrefix(PEER) }).row;
  applyTaskRows([done, decode(hiddenWire as WireTask), decode(shown)], peerLink, { filePath: file });
  expect(find(file, done.id)!.board).toBe("hidden");
  expect(find(file, hidden.id)!.board).toBe("hidden");
  expect(find(file, shown.id)!.board).toBe("shown");
  const repaired = find(file, legacy.id)!;
  const { board: _board, boardAutoHidden: _automatic, revision: _revision, ...rest } = repaired as TaskWithRevision;
  const { revision: _oldRevision, ...originalFields } = before as TaskWithRevision;
  expect(rest).toEqual(originalFields);
  expect(repaired.board).toBe("hidden");
  expect(repaired.boardAutoHidden).toBe(true);
  expect(loadTasksFile(file).recentCreates).toEqual(receipts);
  expect(find(file, privateTask.id)!.board).toBeUndefined();
  const marker = loadTasksFile(file).migrations;
  expect(Object.keys(marker ?? {}).some((name) => name.includes("linkedArrivals"))).toBe(true);
  // Fill the shown band allowance, then keep every overflow task off-board.
  mutateTasks((tasks) => {
    let next = tasks;
    while (countBoardTasks(next, key, () => false) < BOARD_TASKS_PER_PROJECT_LIMIT) {
      const result = createTask(next, { project: key, text: "Local band", placement: "unplaced" });
      if (!result.ok) throw new Error(result.error);
      next = result.tasks;
    }
    return { tasks: next, result: null };
  }, file);
  const overflow = [peerRow({ id: randomUUID(), board: "shown" }, at), peerRow({ id: randomUUID() }, at)];
  applyTaskRows(overflow, peerLink, { filePath: file });
  expect(countBoardTasks(loadTasks(file), key, () => false)).toBe(BOARD_TASKS_PER_PROJECT_LIMIT);
  for (const row of overflow) expect(find(file, row.id)!.board).toBe("hidden");
  // A later local choice is preserved; replaying the repair changes no revision.
  edit(file, shown.id, { board: "hidden" });
  edit(file, legacy.id, { board: "shown" });
  const revision = readStateCollectionRevision(db, "tasks");
  applyTaskRows([], peerLink, { filePath: file });
  expect(readStateCollectionRevision(db, "tasks")).toBe(revision);
  expect(find(file, legacy.id)!.board).toBe("shown");
  expect(loadTasksFile(file).migrations).toEqual(marker);
  expect(loadTasks(file)).toHaveLength(BOARD_TASKS_PER_PROJECT_LIMIT + 5);
  // A new process has no in-memory guard: the durable marker must still win.
  mutateTasks((tasks) => {
    for (const task of tasks) if (task.id === legacy.id) delete task.board;
    return { tasks, result: null };
  }, file);
  const afterChoice = readStateCollectionRevision(db, "tasks");
  const replay = spawnSync(process.execPath, ["-e", 'import { repairLinkedTasks } from "./src/lib/links/taskRepair.ts"; repairLinkedTasks(process.argv[1]);', file], {
    cwd: process.cwd(), env: { ...process.env }, encoding: "utf8", timeout: 15_000,
  });
  expect(replay.status).toBe(0);
  expect(readStateCollectionRevision(db, "tasks")).toBe(afterChoice);
  expect(find(file, legacy.id)!.board).toBeUndefined();
  expect(loadTasksFile(file).recentCreates).toEqual(receipts);
});
