/**
 * Two isolated installs, each its own process on port 0, syncing tasks over
 * the real peer routes (docs/design/linked-installs.md M.11 slice M2). A
 * makes every call; B is never given A's address. Wire figures come from a
 * TCP counting proxy between the two (`wireMeter.ts`); body figures are
 * `Buffer.byteLength` of what the test server received and answered.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { randomUUID } from "node:crypto";
import { boardPresenceUrl } from "@/hooks/useFiles";
import { derivedStamp, installPrefix } from "./stamp";

import { projectIdentityFromRemote } from "@/lib/projects/identity";
import type { BoardTask } from "@/lib/tasks/types";
import { DONE_TASK_BOARD_RETENTION_MS } from "@/lib/tasks/boardVisibility";
import { meter, WIRE_BUDGET, type Meter } from "./wireMeter";
import { taskShowsOnBoard } from "@/lib/tasks/boardVisibility";
import { createLinkTestInstalls, type Captured } from "./testInstalls";

const fixtures = createLinkTestInstalls();
const { root, remote, key, install, stopInstall, request, link, sync, tasksOf, taskOn, createOn, patchOn, captured, oldSource, seedTranscript } = fixtures;
const meters: Meter[] = [];
afterEach(fixtures.stopAll);
afterAll(async () => {
  for (const counts of meters) counts.close();
  await fixtures.cleanup();
});

test("a conflicting finding reopen converges back to Done over the peer routes", async () => {
  const a = await install("finding-A");
  const b = await install("finding-B");
  const peerId = await link(a, b);
  const body = { project: key, text: "Recurring socket failure", placement: "unplaced", findingKey: "socket:recurrence" };
  const first = (await request(a, "/api/tasks", "POST", body)).body.task as BoardTask;
  expect(first.id).toBeTruthy();
  await sync(a, peerId);
  expect((await request(a, `/api/tasks/${first.id}`, "PATCH", { status: "done" })).status).toBe(200);
  const successor = (await request(a, "/api/tasks", "POST", body)).body.task as BoardTask;
  expect(successor.finding?.previousTaskId).toBe(first.id);
  await sync(a, peerId);
  expect((await request(b, `/api/tasks/${first.id}`, "PATCH", { status: "inbox" })).status).toBe(200);
  for (let round = 0; round < 3; round++) await sync(a, peerId);
  for (const side of [a, b]) {
    const tasks = (await request(side, "/test/tasks")).body as unknown as BoardTask[];
    expect(tasks.find(task => task.id === first.id)?.status).toBe("done");
    expect(tasks.find(task => task.id === successor.id)?.status).toBe("inbox");
  }
  expect((await request(a, `/api/tasks/${successor.id}`, "PATCH", { status: "done" })).status).toBe(200);
  await sync(a, peerId);
  expect((await request(b, `/api/tasks/${first.id}`, "PATCH", { status: "inbox" })).status).toBe(200);
  for (let round = 0; round < 3; round++) await sync(a, peerId);
  const reopened = (await request(a, "/test/tasks")).body as unknown as BoardTask[];
  expect(reopened.find(task => task.id === first.id)?.status).toBe("inbox");
  expect(reopened.filter(task => task.findingKey === body.findingKey && task.status !== "done")).toHaveLength(1);
}, 30_000);

/** Merge-base processes used to seed state as it existed before this fix. */
function mergeBaseSource(revision = "4baabbec88d86b5a9a69d178e2be9881d12fa7fe"): string {
  const source = path.join(root, `source-merge-base-${revision}`);
  if (fs.existsSync(source)) return source;
  fs.mkdirSync(source);
  const archive = spawnSync("git", ["archive", revision, "src", "bin", "tsconfig.json", "package.json"], { maxBuffer: 64 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`merge-base source archive failed: ${archive.stderr.toString()}`);
  const unpack = spawnSync("tar", ["-x", "-C", source], { input: archive.stdout });
  if (unpack.status !== 0) throw new Error(`merge-base source extraction failed: ${unpack.stderr.toString()}`);
  fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(source, "node_modules"), "dir");
  return source;
}

// Exact strict task key set from the pre-board merge-base decoder.
const LEGACY_TASK_KEYS = new Set(["id", "project", "text", "details", "status", "color", "icon", "priority", "placement", "pos", "workLinks", "machine", "handover", "createdAt", "updatedAt", "s"]);
function decodeLegacyTaskRow(row: Record<string, unknown>): void {
  if (Object.keys(row).some((field) => !LEGACY_TASK_KEYS.has(field))) throw new Error("legacy task decoder rejected an unknown field");
  expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(row.project).toBe(key);
  expect(typeof row.text).toBe("string");
}

function fileMarks(name: string): Record<string, { size: number; mtimeMs: number }> {
  const marks: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else { const stat = fs.statSync(file); marks[path.relative(path.join(root, name), file)] = { size: stat.size, mtimeMs: stat.mtimeMs }; }
    }
  };
  walk(path.join(root, name));
  return marks;
}


test("done expiry stops owner exports both ways without deleting replicas; reopen and new admissions resume", async () => {
  const names = ["done-export-A", "done-export-B"];
  const installs = [await install(names[0]!), await install(names[1]!)];
  const peerId = await link(installs[0]!, installs[1]!, undefined, installs[1]!, false);
  const at = Date.now();
  const matrices = [];
  for (const [index, owner] of installs.entries()) {
    const rows = [];
    for (const title of ["Recent done", "Soon expired", "Already expired", "Seat task"]) {
      const task = await createOn(owner, `${title} ${index}`);
      expect((await patchOn(owner, task.id, { status: "done" })).status).toBe(200);
      rows.push((await taskOn(owner, task.id))!);
    }
    const [recent, expiring, old, seat] = rows as [BoardTask, BoardTask, BoardTask, BoardTask];
    recent.doneAt = new Date(at - 3_600_000).toISOString();
    expiring.doneAt = new Date(at - DONE_TASK_BOARD_RETENTION_MS + 60_000).toISOString();
    for (const task of [old, seat]) task.doneAt = new Date(at - DONE_TASK_BOARD_RETENTION_MS - 60_000).toISOString();
    seat.assignments = [{ conversationId: `seat-${index}`, path: null, panePid: null, state: "linked", error: null, at: seat.doneAt! }];
    seat.doneAdmissions = [`seat-${index}`];
    fs.writeFileSync(path.join(root, names[index]!, "orchestrator-seats.json"), JSON.stringify({ schemaVersion: 1, nextSeatEpoch: 2,
      seats: { [key]: { project: key, seatEpoch: 1, conversationId: `seat-${index}`, path: null, mandate: "Fixture seat", state: "active",
        promptVersion: null, predecessorConversationId: null, designatedAt: seat.doneAt, activatedAt: seat.doneAt,
        intent: { clientRequestId: `seat-${index}`, mode: "existing", launchId: null, error: null } } }, pending: {}, revocations: [] }));
    expect((await request(owner, "/test/import-tasks", "POST", { tasks: rows })).status).toBe(200);
    matrices.push({ owner, receiver: installs[1 - index]!, recent, expiring, old, seat });
  }
  await sync(installs[0]!, peerId);
  let pages = await captured(installs[1]!);
  const rowIds = (calls: Captured[], owner?: string) => calls.flatMap((call) => [
    ...(owner === installs[1] ? [] : JSON.parse(call.request).push?.rows ?? []),
    ...(owner === installs[0] ? [] : JSON.parse(call.response).tasks?.rows ?? []),
  ]).map((row) => row.id as string);
  for (const { receiver, recent, expiring, old, seat } of matrices) {
    for (const task of [recent, expiring, seat]) expect((await taskOn(receiver, task.id))?.text).toBe(task.text);
    expect(await taskOn(receiver, old.id)).toBeUndefined();
    expect(rowIds(pages)).not.toContain(old.id);
    expect(rowIds(pages)).toContain(seat.id);
  }
  const beforeGraves = await Promise.all(installs.map(async (side) => (await request(side, "/test/store")).body));
  // Both fixture clocks move together; wire stamps stay within the clock fence.
  for (const side of installs) await request(side, "/test/clock?offset=120000");
  for (const { owner, expiring, old, seat } of matrices) {
    for (const task of [expiring, old, seat]) expect((await patchOn(owner, task.id, { text: `${task.text} changed` })).status).toBe(200);
  }
  await sync(installs[0]!, peerId);
  pages = await captured(installs[1]!);
  for (const { owner, receiver, expiring, old, seat } of matrices) {
    expect(rowIds(pages)).not.toContain(expiring.id);
    expect(rowIds(pages)).not.toContain(old.id);
    expect((await taskOn(owner, expiring.id))?.text).toBe(`${expiring.text} changed`);
    expect((await taskOn(receiver, expiring.id))?.text).toBe(expiring.text);
    expect((await taskOn(receiver, seat.id))?.text).toBe(`${seat.text} changed`);
  }
  // A fresh full scan also omits aged tasks and leaves existing copies intact.
  await request(installs[0]!, "/test/legacy-cursor", "POST", { id: peerId, pull: [0], pushed: [0], projects: [], wireVersion: 3 });
  await sync(installs[0]!, peerId);
  pages = await captured(installs[1]!);
  for (const { owner, receiver, expiring, old } of matrices) {
    expect(rowIds(pages, owner)).not.toContain(expiring.id);
    expect(rowIds(pages, owner)).not.toContain(old.id);
    expect((await taskOn(receiver, expiring.id))?.text).toBe(expiring.text);
  }
  for (const [index, { owner, old, expiring }] of matrices.entries()) {
    expect((await patchOn(owner, old.id, { status: "inbox" })).status).toBe(200);
    const rows = await tasksOf(owner);
    const task = rows.find((row) => row.id === expiring.id)!;
    task.assignments.push({ conversationId: `new-worker-${index}`, path: null, panePid: null, state: "linked", error: null, at: new Date(at + 120_000).toISOString() });
    task.updatedAt = new Date(at + 120_000).toISOString();
    expect((await request(owner, "/test/import-tasks", "POST", { tasks: rows })).status).toBe(200);
  }
  await sync(installs[0]!, peerId);
  pages = await captured(installs[1]!);
  for (const { owner, receiver, old, expiring } of matrices) {
    expect(rowIds(pages)).toContain(old.id);
    expect(rowIds(pages)).toContain(expiring.id);
    expect((await taskOn(receiver, old.id))?.status).toBe("inbox");
    expect((await taskOn(owner, old.id))?.doneAt).toBeUndefined();
    expect((await taskOn(receiver, expiring.id))?.text).toBe(`${expiring.text} changed`);
    expect(await tasksOf(owner)).toHaveLength(8);
  }
  await sync(installs[0]!, peerId);
  for (const [index, side] of installs.entries()) {
    const after = (await request(side, "/test/store")).body;
    expect((after.bytes as Record<string, { rows: number }>).task_tombstones.rows).toBe((beforeGraves[index]!.bytes as Record<string, { rows: number }>).task_tombstones.rows);
  }
}, 30_000);

test.each([false, true])("a new decision after done expiry resumes exports both ways without a task edit (restart=%s); an older decision does not", async (restart) => {
  const names = [`done-decision-A-${restart}`, `done-decision-B-${restart}`];
  const installs = [await install(names[0]!), await install(names[1]!)];
  const peerId = await link(installs[0]!, installs[1]!, undefined, installs[1]!, false);
  const at = Date.now();
  const tasks: BoardTask[] = [];
  for (const [index, owner] of installs.entries()) {
    const name = names[index]!;
    seedTranscript(name, "Fixture decision request");
    const checkout = path.join(root, name, "checkout", "widget");
    const transcript = path.join(root, name, "home", ".claude", "projects", checkout.replace(/[/.]/g, "-"), "session-canary.jsonl");
    const task = await createOn(owner, `Decision task ${index}`);
    expect((await patchOn(owner, task.id, { status: "done" })).status).toBe(200);
    const done = (await taskOn(owner, task.id))!;
    done.doneAt = new Date(at - DONE_TASK_BOARD_RETENTION_MS - 60_000).toISOString();
    done.assignments = [{ path: transcript, panePid: null, state: "linked", error: null, at: done.doneAt }];
    done.doneAdmissions = [transcript];
    await request(owner, "/test/import-tasks", "POST", { tasks: [done] });
    await request(owner, `/test/agent-state?state=waiting&since=${(at - 120_000) / 1000}`);
    await request(owner, "/test/scan");
    tasks.push(done);
  }
  await sync(installs[0]!, peerId);
  for (const [index, task] of tasks.entries()) expect(await taskOn(installs[1 - index]!, task.id)).toBeUndefined();
  await sync(installs[0]!, peerId);
  for (const [index, task] of tasks.entries()) expect(await taskOn(installs[1 - index]!, task.id)).toBeUndefined();
  const originals = await Promise.all(installs.map((owner, index) => taskOn(owner, tasks[index]!.id)));
  if (restart) {
    await Promise.all(installs.map(stopInstall));
    for (const [index, name] of names.entries()) installs[index] = await install(name);
  }
  for (const [index, owner] of installs.entries()) {
    await request(owner, `/test/agent-state?state=waiting&since=${at / 1000}`);
    await request(owner, "/test/scan");
    expect(await taskOn(owner, tasks[index]!.id)).toEqual(originals[index]);
  }
  await sync(installs[0]!, peerId);
  for (const [index, task] of tasks.entries()) {
    expect((await taskOn(installs[1 - index]!, task.id))?.text).toBe(task.text);
    expect(await taskOn(installs[index]!, task.id)).toEqual(originals[index]);
    expect(await tasksOf(installs[index]!)).toHaveLength(2);
    const figures = (await request(installs[index]!, "/test/store")).body;
    expect((figures.bytes as Record<string, { rows: number }>).task_tombstones.rows).toBe(0);
  }
  await captured(installs[1]!);
  await sync(installs[0]!, peerId);
  expect((await captured(installs[1]!)).every((page) =>
    !(JSON.parse(page.request).push?.rows?.length) && !(JSON.parse(page.response).tasks?.rows?.length))).toBe(true);
}, 30_000);

test.each(["seat", "pipeline"] as const)("a changed %s resumes omitted Done tasks without owner edits in both directions", async (kind) => {
  const names = [`done-${kind}-A`, `done-${kind}-B`];
  const installs = [await install(names[0]!), await install(names[1]!)];
  const peerId = await link(installs[0]!, installs[1]!, undefined, installs[1]!, false);
  const originals: BoardTask[] = [];
  for (const [index, owner] of installs.entries()) {
    const task = await createOn(owner, `Expired ${kind} task ${index}`);
    expect((await patchOn(owner, task.id, { status: "done" })).status).toBe(200);
    const done = (await taskOn(owner, task.id))!;
    done.doneAt = new Date(Date.now() - DONE_TASK_BOARD_RETENTION_MS - 60_000).toISOString();
    done.assignments = [{ conversationId: `seat-${index}`, path: null, panePid: null, state: "linked", error: null, at: done.doneAt }];
    done.doneAdmissions = [`seat-${index}`];
    expect((await request(owner, "/test/import-tasks", "POST", { tasks: [done] })).status).toBe(200);
    originals.push((await taskOn(owner, done.id))!);
  }
  await sync(installs[0]!, peerId);
  await sync(installs[0]!, peerId);
  for (const [index, task] of originals.entries()) expect(await taskOn(installs[1 - index]!, task.id)).toBeUndefined();
  for (const [index, owner] of installs.entries()) {
    if (kind === "pipeline") {
      expect((await laneOn(owner, { id: "a1b2c3d4", taskIds: [originals[index]!.id], state: "needs_decision", current: "review", stages: threeStages("review") })).status).toBe(200);
    } else {
      fs.writeFileSync(path.join(root, names[index]!, "orchestrator-seats.json"), JSON.stringify({ schemaVersion: 1, nextSeatEpoch: 2,
        seats: { [key]: { project: key, seatEpoch: 1, conversationId: `seat-${index}`, path: null, mandate: "Fixture seat", state: "active",
          promptVersion: null, predecessorConversationId: null, designatedAt: originals[index]!.doneAt, activatedAt: originals[index]!.doneAt,
          intent: { clientRequestId: `seat-${index}`, mode: "existing", launchId: null, error: null } } }, pending: {}, revocations: [] }));
    }
  }
  await sync(installs[0]!, peerId);
  for (const [index, task] of originals.entries()) {
    expect((await taskOn(installs[1 - index]!, task.id))?.text).toBe(task.text);
    expect(await taskOn(installs[index]!, task.id)).toEqual(task);
  }
}, 30_000);

test("remote agents travel both ways as prompt-free summaries and stay in their linked project", async () => {
  const secondRemote = "code.example.test/acme/other";
  const thirdRemote = "code.example.test/acme/local-only";
  const secondKey = projectIdentityFromRemote(`https://${secondRemote}`, "/")!.project;
  const thirdKey = projectIdentityFromRemote(`https://${thirdRemote}`, "/")!.project;
  const extra = { [secondKey]: secondRemote, [thirdKey]: thirdRemote };
  const a = await install("agents-A", extra);
  const b = await install("agents-B", extra);
  const peerId = await link(a, b, { projects: [key, secondKey] });
  expect((await request(a, "/api/links/shared", "POST", { v: 1, all: false, projects: [key, secondKey, thirdKey] })).status).toBe(200);
  await sync(a, peerId);
  seedTranscript("agents-A", "PROMPT-CANARY-A-remote-agent");
  seedTranscript("agents-A", "PROMPT-CANARY-A-other-project", secondRemote, "session-other");
  seedTranscript("agents-A", "PROMPT-CANARY-A-local-only", thirdRemote, "session-local-only");
  seedTranscript("agents-B", "PROMPT-CANARY-B-remote-agent");
  const bound = await request(b, "/test/prompts", "POST", { project: key, launch: "PROMPT-CANARY-launch", goal: "PROMPT-CANARY-stage", curator: "PROMPT-CANARY-curator" });
  expect(bound.status).toBe(200);
  const scanA = await request(a, "/test/scan");
  const scanB = await request(b, "/test/scan");
  expect(scanA.status).toBe(200);
  expect(scanB.status).toBe(200);
  expect((scanA.body.files as { project: string }[]).map((file) => file.project).sort()).toEqual([key, secondKey, thirdKey].sort());
  await captured(b);
  await sync(a, peerId);
  const onA = (await request(a, `/test/agents?project=${key}`)).body as unknown as { t: string; peer: string; p: string; task?: string }[];
  const onB = (await request(b, `/test/agents?project=${key}`)).body as unknown as { t: string; peer: string; p: string; task?: string }[];
  expect(onA).toHaveLength(1);
  expect(onB).toHaveLength(1);
  expect(((await request(b, `/test/agents?project=${secondKey}`)).body as unknown as unknown[])).toHaveLength(1);
  expect(((await request(b, `/test/agents?project=${thirdKey}`)).body as unknown as unknown[])).toHaveLength(0);
  expect(onA[0]).toMatchObject({ t: "claude agent", p: key });
  expect(onB[0]).toMatchObject({ t: "claude agent", p: key });
  expect(onA[0]!.task).toBeTruthy();
  expect(onB[0]!.task).toBeUndefined();
  await request(b, "/test/clock?offset=960000");
  expect(((await request(b, `/test/agents?project=${key}`)).body as unknown as { stale: boolean }[])[0]!.stale).toBe(true);
  await request(b, "/test/clock?offset=0");
  await sync(a, peerId);
  expect(((await request(b, `/test/agents?project=${key}`)).body as unknown as { stale: boolean }[])[0]!.stale).toBe(false);
  const bodies = (await captured(b)).flatMap((item) => [item.request, item.response]).join("\n");
  for (const forbidden of ["session-canary", "/checkout/", "/home/"]) expect(bodies).not.toContain(forbidden);
  const grant = ((await request(b, "/api/links/grants")).body.grants as { id: string }[])[0]!;
  expect((await request(b, `/api/links/grants?id=${grant.id}`, "DELETE")).body.removed).toBe(true);
  expect((await request(b, `/test/agents?project=${key}`)).body as unknown).toEqual([]);
  expect(await request(a, `/api/links/peers/${peerId}`, "POST")).toMatchObject({ status: 409, body: { error: "revoked" } });
  expect((await request(a, `/test/agents?project=${key}`)).body as unknown).toEqual([]);
});

test("a changed remote shared list does not strand task or agent deltas awaiting an ack", async () => {
  const addedRemote = "code.example.test/acme/newly-shared";
  const addedKey = projectIdentityFromRemote(`https://${addedRemote}`, "/")!.project;
  const extra = { [addedKey]: addedRemote };
  const a = await install("renegotiate-A", extra);
  const b = await install("renegotiate-B", extra);
  const peerId = await link(a, b);
  seedTranscript("renegotiate-A", "PROMPT-CANARY-renegotiate");
  expect((await request(a, "/test/scan")).status).toBe(200);
  const task = await createOn(a, "Task during project negotiation");
  expect((await request(b, "/api/links/shared", "POST", { v: 1, all: false, projects: [key, addedKey] })).status).toBe(200);
  await captured(b);

  await sync(a, peerId);
  const calls = (await captured(b)).map((entry) => ({
    request: JSON.parse(entry.request) as { push?: { agents?: { cursor: string } } },
    response: JSON.parse(entry.response) as { shared?: unknown[]; agentAck?: string },
  }));
  const unacked = calls.find((call) => call.request.push?.agents && call.response.shared && call.response.agentAck === undefined);
  expect(unacked).toBeDefined();
  expect(calls.some((call) => {
    const cursor = call.request.push?.agents?.cursor;
    return cursor !== undefined && cursor === unacked?.request.push?.agents?.cursor && call.response.agentAck === cursor;
  })).toBe(true);
  expect((await taskOn(b, task.id))?.text).toBe(task.text);
  expect((await request(b, `/test/agents?project=${key}`)).body as unknown as unknown[]).toHaveLength(1);
  const peerState = (await request(a, "/api/links/peers")).body;
  expect(peerState.peers).toEqual(expect.arrayContaining([expect.objectContaining({ id: peerId, state: "active" })]));
  expect(peerState.states).toEqual(expect.arrayContaining([expect.objectContaining({ id: peerId,
    projects: expect.arrayContaining([expect.objectContaining({ key: addedKey, state: "only-there" })]) })]));
});

test("one agent change adds one bounded row on the measured sync transport", async () => {
  const a = await install("agent-meter-A");
  const b = await install("agent-meter-B");
  const wire = await meter(b);
  meters.push(wire);
  const peerId = await link(a, b, { projects: [key] }, wire.url);
  await sync(a, peerId);
  await captured(b);
  const idleUp = wire.up, idleDown = wire.down;
  await sync(a, peerId);
  const idleBytes = wire.up - idleUp + wire.down - idleDown;
  const idle = (await captured(b))[0]!;
  expect(Buffer.byteLength(idle.request)).toBeLessThanOrEqual(200);
  expect(Buffer.byteLength(idle.response)).toBeLessThanOrEqual(200);
  expect(idleBytes).toBeLessThanOrEqual(WIRE_BUDGET);
  seedTranscript("agent-meter-A", "PROMPT-CANARY-agent-meter");
  await request(a, "/test/scan");
  const changedUp = wire.up, changedDown = wire.down;
  await sync(a, peerId);
  const changedBytes = wire.up - changedUp + wire.down - changedDown;
  const bodies = await captured(b);
  expect(bodies).toHaveLength(1);
  const pushed = (JSON.parse(bodies[0]!.request) as { push?: { agents?: { rows?: unknown[] } } }).push?.agents;
  expect(pushed?.rows).toHaveLength(1);
  const rowBytes = Buffer.byteLength(JSON.stringify(pushed!.rows![0]));
  expect(rowBytes).toBeLessThanOrEqual(1536);
  expect(changedBytes - idleBytes).toBeLessThanOrEqual(rowBytes + 300);
  expect(bodies[0]!.request + bodies[0]!.response).not.toContain("PROMPT-CANARY");
});

test("B's state flip returns one agent row and agent exchange writes no disk state", async () => {
  const a = await install("agent-flip-A");
  const b = await install("agent-flip-B");
  const peerId = await link(a, b);
  seedTranscript("agent-flip-B", "PROMPT-CANARY-state", remote, "session-flip");
  await request(b, "/test/scan");
  await sync(a, peerId);
  expect(((await request(a, `/test/agents?project=${key}`)).body as unknown as { st: string }[])[0]!.st).toBe("done");
  await request(b, "/test/agent-state?state=running");
  await request(b, "/test/scan");
  const diskA = fileMarks("agent-flip-A");
  const diskB = fileMarks("agent-flip-B");
  await captured(b);
  await sync(a, peerId);
  const calls = await captured(b);
  const changed = calls.map((call) => (JSON.parse(call.response) as { agents?: { rows?: { st: string }[] } }).agents?.rows ?? []).flat();
  expect(changed).toHaveLength(1);
  expect(changed[0]!.st).toBe("working");
  expect(((await request(a, `/test/agents?project=${key}`)).body as unknown as { st: string }[])[0]!.st).toBe("working");
  expect(fileMarks("agent-flip-A")).toEqual(diskA);
  expect(fileMarks("agent-flip-B")).toEqual(diskB);
  expect(calls.map((call) => call.response).join("\n")).not.toContain("PROMPT-CANARY");
});

test("200 agents reset over the real link in four bounded transport pages", async () => {
  const origins = Array.from({ length: 4 }, (_, n) => `code.example.test/acme/agent-batch-${n}`);
  const remotes = Object.fromEntries(origins.map((origin) => [projectIdentityFromRemote(`https://${origin}`, "/")!.project, origin]));
  const keys = Object.keys(remotes);
  const a = await install("agent-pages-A", remotes);
  const b = await install("agent-pages-B", remotes);
  const wire = await meter(b);
  meters.push(wire);
  const peerId = await link(a, b, { projects: keys }, wire.url);
  for (const origin of origins) for (let n = 0; n < 50; n++) seedTranscript("agent-pages-B", `PROMPT-CANARY-${n}`, origin, `session-${origin.at(-1)}-${n}`);
  const scan = await request(b, "/test/scan");
  expect((scan.body.files as unknown as unknown[]).length).toBe(200);
  await sync(a, peerId);
  for (const key of keys) expect(((await request(a, `/test/agents?project=${key}`)).body as unknown as unknown[])).toHaveLength(50);
  await request(a, `/test/agent-reset?id=${peerId}`);
  await captured(b);
  const before = wire.up + wire.down;
  await sync(a, peerId);
  const bytes = wire.up + wire.down - before;
  const calls = await captured(b);
  const pages = calls.map((call) => ({ wire: call, agents: (JSON.parse(call.response) as { agents?: { rows?: unknown[]; reset?: boolean; more?: boolean } }).agents }))
    .filter((entry) => entry.agents?.rows?.length);
  expect(pages).toHaveLength(4);
  expect(pages[0]!.agents!.reset).toBe(true);
  for (const page of pages) {
    expect(page.agents!.rows).toHaveLength(50);
    expect(Buffer.byteLength(page.wire.response)).toBeLessThan(512 * 1024);
    expect(page.wire.response).not.toContain("PROMPT-CANARY");
  }
  expect(bytes).toBeLessThan(100_000);
});

test("a feed restart between transport reset pages restarts at row zero without mixing epochs", async () => {
  const origins = Array.from({ length: 4 }, (_, n) => `code.example.test/acme/restart-${n}`);
  const remotes = Object.fromEntries(origins.map((origin) => [projectIdentityFromRemote(`https://${origin}`, "/")!.project, origin]));
  const keys = Object.keys(remotes);
  const a = await install("agent-restart-A", remotes);
  const b = await install("agent-restart-B", remotes);
  const peerId = await link(a, b, { projects: keys });
  for (const origin of origins) for (let n = 0; n < 50; n++) seedTranscript("agent-restart-B", `PROMPT-CANARY-${n}`, origin, `session-${origin.at(-1)}-${n}`);
  expect(((await request(b, "/test/scan")).body.files as unknown[])).toHaveLength(200);
  await sync(a, peerId);
  const grantId = ((await request(b, "/api/links/grants")).body.grants as { id: string }[])[0]!.id;
  await request(a, `/test/agent-reset?id=${peerId}`);
  await request(b, `/test/agent-feed-restart?id=${grantId}`);
  await captured(b);
  await sync(a, peerId);
  const pages = (await captured(b)).map((call) => (JSON.parse(call.response) as { agents?: { cursor: string; reset?: boolean; rows?: { k: string }[] } }).agents).filter(Boolean);
  expect(pages.filter((page) => page!.reset)).toHaveLength(2);
  expect(pages[0]!.cursor).not.toBe(pages[1]!.cursor);
  expect(pages[1]!.rows?.map((row) => row.k)).toEqual(pages[0]!.rows?.map((row) => row.k));
  for (const project of keys) expect(((await request(a, `/test/agents?project=${project}`)).body as unknown as unknown[])).toHaveLength(50);
});

test("tasks created, changed in every group and deleted on either machine show on the other after one call; shared titles cross; an idle link costs next to nothing", async () => {
  const a = await install("both-A");
  const b = await install("both-B");
  const wire = await meter(b);
  meters.push(wire);
  // Pre-M2 rows whose text is a prompt, written before anything is linked.
  const canaryA = (await request(a, "/test/bulk", "POST", { project: key, count: 1, text: "CANARY-A-first-prompt", explicit: false })).body.ids as string[];
  const canaryB = (await request(b, "/test/bulk", "POST", { project: key, count: 1, text: "CANARY-B-launch-prompt", explicit: false })).body.ids as string[];
  // Tasks made by the paths that title a task from a prompt: the transcript
  // scan's admission, a launch's display prompt, a pipeline goal, a curator card.
  seedTranscript("both-A", "CANARY-SCAN-first-prompt of a scanned conversation");
  const admitted = (await request(a, "/test/prompts", "POST", { project: key, launch: "CANARY-LAUNCH-display-prompt", goal: "CANARY-GOAL-pipeline-goal", curator: "CANARY-CURATOR-line" })).body as
    { scanned: number; curated: number; tasks: { id: string; text: string }[] };
  expect(admitted.scanned).toBe(1);
  expect(admitted.curated).toBe(1);
  const prompted = admitted.tasks;
  for (const canary of ["CANARY-SCAN", "CANARY-LAUNCH", "CANARY-GOAL", "CANARY-CURATOR"]) expect(prompted.some((task) => task.text.includes(canary))).toBe(true);
  // Keep every body to verify the shared texts and field allowlist.
  const bodies: string[] = [];
  const drain = async () => { for (const call of await captured(b)) bodies.push(call.request, call.response); };
  const peerId = await link(a, b, { projects: [key] }, wire.url);
  await sync(a, peerId);
  expect((await taskOn(b, canaryA[0]!))?.text).toBe("CANARY-A-first-prompt");
  expect((await taskOn(a, canaryB[0]!))?.text).toBe("CANARY-B-launch-prompt");
  for (const task of prompted) expect((await taskOn(b, task.id))?.text).toBe(task.text);
  await drain();
  expect(bodies.join("\n")).not.toContain(root);

  // Create on A: B has it after one call.
  const made = await createOn(a, "Plan the release");
  await sync(a, peerId);
  expect((await taskOn(b, made.id))?.text).toBe("Plan the release");
  expect((await taskOn(b, made.id))?.machine).toBe((await taskOn(a, made.id))!.machine);
  // Every group, from A and from B, each after one call.
  const groups: [string, Record<string, unknown>, (task: BoardTask) => unknown, unknown][] = [
    ["text", { text: "Plan the release, v2", details: "notes for agents" }, (task) => [task.text, task.details], ["Plan the release, v2", "notes for agents"]],
    ["status", { status: "blocked" }, (task) => task.status, "blocked"],
    ["look", { color: "sky", icon: "rocket", priority: "high" }, (task) => [task.color, task.icon, task.priority], ["sky", "rocket", "high"]],
    ["place", { pos: { x: 120, y: 340 } }, (task) => [task.placement, task.pos], ["pinned", { x: 120, y: 340 }]],
    ["links", { attachLinks: "acme/widget#12", linkKind: "pr" }, (task) => task.workLinks?.map((link) => `${link.repository}#${link.number}`), ["acme/widget#12"]],
  ];
  for (const [group, patch, read, expected] of groups) {
    expect((await patchOn(a, made.id, patch)).status).toBe(200);
    await sync(a, peerId);
    expect([group, read((await taskOn(b, made.id))!)]).toEqual([group, expected]);
  }
  const back: [Record<string, unknown>, (task: BoardTask) => unknown, unknown][] = [
    [{ text: "Edited on B" }, (task) => task.text, "Edited on B"],
    [{ status: "done" }, (task) => task.status, "done"],
    [{ color: "lime" }, (task) => task.color, "lime"],
    [{ placement: "unplaced" }, (task) => task.placement, "unplaced"],
    [{ detachLinks: "acme/widget#12" }, (task) => task.workLinks ?? [], []],
  ];
  for (const [patch, read, expected] of back) {
    expect((await patchOn(b, made.id, patch)).status).toBe(200);
    await sync(a, peerId);
    expect(read((await taskOn(a, made.id))!)).toEqual(expected);
  }
  const fromB = await createOn(b, "Made on B");
  await sync(a, peerId);
  expect((await taskOn(a, fromB.id))?.text).toBe("Made on B");

  // Different groups on both sides both survive.
  expect((await patchOn(a, fromB.id, { color: "amber" })).status).toBe(200);
  expect((await patchOn(b, fromB.id, { status: "blocked" })).status).toBe(200);
  await sync(a, peerId);
  for (const side of [a, b]) expect([(await taskOn(side, fromB.id))!.color, (await taskOn(side, fromB.id))!.status]).toEqual(["amber", "blocked"]);

  // B changes status, then applies A's text change before A's next call:
  // that same call brings B's status back to A (the `o` rule).
  expect((await patchOn(b, made.id, { status: "assigned" })).status).toBe(200);
  expect((await patchOn(a, made.id, { text: "Text from A" })).status).toBe(200);
  await sync(a, peerId);
  expect((await taskOn(a, made.id))!.status).toBe("assigned");
  expect((await taskOn(b, made.id))!.text).toBe("Text from A");

  // Project consent includes task text, including automatically populated titles.
  await drain();
  expect(bodies.length).toBeGreaterThan(20);
  expect(bodies.join("\n")).toContain("CANARY-A-first-prompt");

  // Naming the prompt rows sends their text, the same words included.
  expect((await patchOn(a, canaryA[0]!, { text: "CANARY-A-first-prompt" })).status).toBe(200);
  expect((await patchOn(b, canaryB[0]!, { text: "A title chosen on B" })).status).toBe(200);
  const named = prompted.map((task, index) => [task.id, index === 0 ? task.text : `Named task ${index}`] as const);
  for (const [id, text] of named) expect((await patchOn(a, id, { text })).status).toBe(200);
  await sync(a, peerId);
  expect((await taskOn(b, canaryA[0]!))!.text).toBe("CANARY-A-first-prompt");
  expect((await taskOn(a, canaryB[0]!))!.text).toBe("A title chosen on B");
  for (const [id, text] of named) expect((await taskOn(b, id))!.text).toBe(text);

  // Edit against delete: the delete wins on both.
  expect((await patchOn(a, fromB.id, { text: "edited while deleted" })).status).toBe(200);
  expect((await request(b, `/api/tasks/${fromB.id}`, "DELETE")).status).toBe(200);
  await sync(a, peerId);
  await sync(a, peerId);
  expect(await taskOn(a, fromB.id)).toBeUndefined();
  expect(await taskOn(b, fromB.id)).toBeUndefined();
  expect((await request(a, `/api/tasks/${made.id}`, "DELETE")).status).toBe(200);
  await sync(a, peerId);
  expect(await taskOn(b, made.id)).toBeUndefined();

  // Quiet: a replayed page and an echo raise no revision; 100 idle calls write
  // nothing on either side and stay inside the byte budget.
  await sync(a, peerId);
  const revisions = [(await request(a, "/test/revision")).body.revision, (await request(b, "/test/revision")).body.revision];
  await captured(b);
  const diskA = fileMarks("both-A");
  const diskB = fileMarks("both-B");
  const before = (await request(b, "/test/metrics")).body as { syncCalls: number };
  const wireBefore = { total: wire.up + wire.down, connections: wire.connections };
  for (let i = 0; i < 100; i++) await sync(a, peerId);
  const after = (await request(b, "/test/metrics")).body as { syncCalls: number };
  expect(after.syncCalls - before.syncCalls).toBe(100);
  expect(wire.connections - wireBefore.connections).toBe(100);
  const idle = await captured(b);
  expect(Math.max(...idle.map((call) => Buffer.byteLength(call.request)))).toBeLessThanOrEqual(200);
  expect(Math.max(...idle.map((call) => Buffer.byteLength(call.response)))).toBeLessThanOrEqual(200);
  // Request line, headers and bodies both ways, as counted on the TCP connection.
  expect((wire.up + wire.down - wireBefore.total) / 100).toBeLessThanOrEqual(WIRE_BUDGET);
  expect([(await request(a, "/test/revision")).body.revision, (await request(b, "/test/revision")).body.revision]).toEqual(revisions);
  expect(fileMarks("both-A")).toEqual(diskA);
  expect(fileMarks("both-B")).toEqual(diskB);
  // Across two hourly flush points an idle link still writes nothing (M.10).
  for (const hour of [1, 2, 3]) {
    for (const side of [a, b]) await request(side, `/test/clock?offset=${hour * 3_600_000 + 60_000}`);
    for (let i = 0; i < 5; i++) await sync(a, peerId);
  }
  expect(fileMarks("both-A")).toEqual(diskA);
  expect(fileMarks("both-B")).toEqual(diskB);
}, 120_000);

test("an idle call costs at most 2 ms of CPU on each side, and 1 000 calls grow neither heap", async () => {
  const a = await install("cpu-A");
  const b = await install("cpu-B");
  for (const side of [a, b]) await request(side, "/test/capture?on=0");
  await request(a, "/test/bulk", "POST", { project: key, count: 300 });
  await request(b, "/test/bulk", "POST", { project: key, count: 300 });
  const peerId = await link(a, b);
  await sync(a, peerId);
  for (let i = 0; i < 100; i++) await sync(a, peerId);
  const cpu = async () => Promise.all([a, b].map(async (side) => (await request(side, "/test/cpu")).body.ms as number));
  const cpuBefore = await cpu();
  for (let i = 0; i < 1_000; i++) await sync(a, peerId);
  const cpuAfter = await cpu();
  expect(cpuAfter[0]! - cpuBefore[0]!).toBeLessThanOrEqual(2_000);
  expect(cpuAfter[1]! - cpuBefore[1]!).toBeLessThanOrEqual(2_000);
  /* Bun's heap after a forced collection keeps growing for the first few
     thousand requests of any route, linked or not (about 800 KB from call 100
     to call 1 100 with no project shared); it levels off after about 3 000.
     Growth is read once the runtime has warmed up. */
  for (let i = 0; i < 2_000; i++) await sync(a, peerId);
  const heap = async () => Promise.all([a, b].map(async (side) => (await request(side, "/test/heap")).body.heapUsed as number));
  const heapBefore = await heap();
  for (let i = 0; i < 1_000; i++) await sync(a, peerId);
  const heapAfter = await heap();
  expect(heapAfter[0]! - heapBefore[0]!).toBeLessThan(256 * 1024);
  expect(heapAfter[1]! - heapBefore[1]!).toBeLessThan(256 * 1024);
}, 120_000);

test("M3 link RSS and heap are measured with 2 000 tasks, 200 agents per side, edits and churn; steady heap stays flat", async () => {
  const origins = Array.from({ length: 3 }, (_, n) => `code.example.test/acme/memory-${n}`);
  const remotes = Object.fromEntries(origins.map((origin) => [projectIdentityFromRemote(`https://${origin}`, "/")!.project, origin]));
  const projectKeys = Object.keys(remotes);
  type Memory = { rss: number; heapUsed: number };
  const heap = async (sides: readonly string[]) => Promise.all(sides.map(async (side) => (await request(side, "/test/heap")).body as Memory));
  const populated = async (run: number, mode: "off" | "on") => {
    const names = [`memory-${run}-${mode}-A`, `memory-${run}-${mode}-B`];
    const sides = await Promise.all(names.map((name) => install(name, remotes)));
    const editIds: string[] = [];
    for (const side of sides) {
      // The capture harness retains whole sync bodies; exclude that test-only
      // memory from the link's RSS measurement.
      await request(side, "/test/measure-memory");
    }
    for (let project = 0; project < 3; project++) {
      const ids = (await request(sides[0]!, "/test/bulk", "POST", { project: projectKeys[project]!, count: project === 2 ? 666 : 667 })).body.ids as string[];
      if (project === 0) editIds.push(ids[0]!);
    }
    const tasks = await tasksOf(sides[0]!);
    expect((await request(sides[1]!, "/test/import-tasks", "POST", { tasks })).body.count).toBe(2_000);
    editIds.push(editIds[0]!);
    for (const name of names) for (let project = 0; project < 3; project++)
      for (let agent = 0; agent < (project === 2 ? 66 : 67); agent++) seedTranscript(name, `PROMPT-CANARY-${agent}`, origins[project]!, `session-${project}-${agent}`);
    const peerId = await link(sides[0]!, sides[1]!, { projects: mode === "on" ? projectKeys : [] }, sides[1]!, false);
    return { sides, editIds, peerId };
  };
  const work = async (sides: readonly string[], editIds: readonly string[], start: number, end: number, peerId?: string, agents = true) => {
    const [a, b] = sides as [string, string];
    for (let call = start; call < end; call++) {
      if (call % 100 === 0) {
        expect((await patchOn(a, editIds[0]!, { text: `Edit ${Math.floor(call / 100) % 2}` })).status).toBe(200);
        expect((await patchOn(b, editIds[1]!, { text: `Edit ${Math.floor(call / 100) % 2}` })).status).toBe(200);
      }
      if (agents && call % 200 === 0) for (const side of sides) {
        await request(side, `/test/agent-state?state=${call % 400 === 0 ? "running" : "done"}`);
        await request(side, "/test/scan");
      }
      if (peerId) await sync(a, peerId);
      else { await request(a, "/test/metrics"); await request(b, "/test/metrics"); }
    }
  };
  const stages = ["no calls", "tasks only", "tasks + agents"] as const;
  const measurements: Array<{ off: Memory[][]; on: Memory[][] }> = [];
  const growth: number[][] = [[], []];
  for (let run = 0; run < 3; run++) {
    const pair: { off: Memory[][]; on: Memory[][] } = { off: [], on: [] };
    for (const mode of ["off", "on"] as const) {
      const fixture = await populated(run, mode);
      try {
        pair[mode].push(await heap(fixture.sides));
        await work(fixture.sides, fixture.editIds, 0, 100, fixture.peerId, false);
        const grantId = ((await request(fixture.sides[1]!, "/api/links/grants")).body.grants as { id: string }[])[0]!.id;
        for (const [side, id] of [[fixture.sides[0]!, `peer:${fixture.peerId}`], [fixture.sides[1]!, `grant:${grantId}`]]) {
          expect((await request(side, `/test/agent-maps?id=${id}`)).body).toEqual({ scanned: 0, local: { rows: 0, markers: 0 }, remote: 0 });
        }
        pair[mode].push(await heap(fixture.sides));
        for (const side of fixture.sides) expect(((await request(side, "/test/scan")).body.files as unknown[])).toHaveLength(200);
        await work(fixture.sides, fixture.editIds, 100, 1_100, fixture.peerId);
        if (mode === "on") for (const [side, id] of [[fixture.sides[0]!, `peer:${fixture.peerId}`], [fixture.sides[1]!, `grant:${grantId}`]]) {
          expect((await request(side, `/test/agent-maps?id=${id}`)).body).toMatchObject({ scanned: 200, local: { rows: 150 }, remote: 150 });
        }
        pair[mode].push(await heap(fixture.sides));
        if (mode === "on") {
          await work(fixture.sides, fixture.editIds, 1_100, 3_100, fixture.peerId);
          const before = await heap(fixture.sides);
          await work(fixture.sides, fixture.editIds, 3_100, 4_100, fixture.peerId);
          const after = await heap(fixture.sides);
          for (let side = 0; side < 2; side++) growth[side]!.push(after[side]!.heapUsed - before[side]!.heapUsed);
        }
      } finally { await Promise.all(fixture.sides.map(stopInstall)); }
    }
    measurements.push(pair);
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[1]!;
  for (let stage = 0; stage < stages.length; stage++) for (let side = 0; side < 2; side++) {
    const rss = median(measurements.map((pair) => pair.on[stage]![side]!.rss - pair.off[stage]![side]!.rss));
    const heapUsed = median(measurements.map((pair) => pair.on[stage]![side]!.heapUsed - pair.off[stage]![side]!.heapUsed));
    const control = median(measurements.map((pair) => pair.off[stage]![1]!.rss - pair.off[stage]![0]!.rss));
    const runs = measurements.map((pair) => ({ rss: pair.on[stage]![side]!.rss - pair.off[stage]![side]!.rss,
      heapUsed: pair.on[stage]![side]!.heapUsed - pair.off[stage]![side]!.heapUsed }));
    console.log(`M.9 ${stages[stage]} side ${side}: median RSS ${rss} B, median heapUsed ${heapUsed} B, off-pair side RSS spread ${control} B, runs ${JSON.stringify(runs)}`);
  }
  console.log(`M.9 warmed heap growth over 1 000 further calls, three runs per side: ${JSON.stringify(growth)} B`);
  for (const side of growth) expect(median(side)).toBeLessThan(256 * 1024);
}, 600_000);

test("1 000 tasks arrive in 5 pages of at most 512 KB; 1 100 writes on B while A is away push A below the change floor, and the resync converges without a duplicate", async () => {
  const a = await install("pages-A");
  const b = await install("pages-B");
  await request(b, "/test/bulk", "POST", { project: key, count: 1_000 });
  await captured(b);
  const peerId = await link(a, b);
  const pages = (await captured(b)).map((call) => JSON.parse(call.response) as { tasks?: { rows?: unknown[] } }).filter((answer) => answer.tasks?.rows?.length);
  expect(pages.length).toBeLessThanOrEqual(5);
  const firstCalls = await captured(b, false);
  for (const call of firstCalls) expect(Buffer.byteLength(call.response)).toBeLessThanOrEqual(512 * 1024);
  expect((await tasksOf(a)).filter((task) => task.project === key)).toHaveLength(1_000);

  await request(b, "/test/bulk", "POST", { project: key, count: 1_100, each: true });
  await captured(b);
  await sync(a, peerId);
  const resyncCalls = (await captured(b)).map((call) => JSON.parse(call.response) as { tasks?: { resync?: boolean } });
  expect(resyncCalls.some((answer) => answer.tasks?.resync === true)).toBe(true);
  const onA = (await tasksOf(a)).filter((task) => task.project === key);
  const onB = (await tasksOf(b)).filter((task) => task.project === key);
  expect(onA).toHaveLength(2_100);
  expect(new Set(onA.map((task) => task.id)).size).toBe(2_100);
  expect(new Set(onA.map((task) => task.id))).toEqual(new Set(onB.map((task) => task.id)));
}, 180_000);

test("A pushes a transaction of 201 linked tasks, and cap-sized rows past 512 KB, in pages inside one sync; nothing repeats or is skipped", async () => {
  const a = await install("push-pages-A");
  const b = await install("push-pages-B");
  const peerId = await link(a, b);
  await sync(a, peerId);
  const pushPages = (calls: Captured[]) => calls.map((call) => JSON.parse(call.request) as { push?: { rows?: { id: string }[] } })
    .flatMap((body) => body.push?.rows?.length ? [body.push.rows.map((row) => row.id)] : []);

  // One revision of 201 rows: a page of 200 and a page of 1, both in this one sync.
  await captured(b);
  const bulk = (await request(a, "/test/bulk", "POST", { project: key, count: 201 })).body.ids as string[];
  await sync(a, peerId);
  const pages = pushPages(await captured(b));
  expect(pages.map((page) => page.length)).toEqual([200, 1]);
  expect(pages.flat().sort()).toEqual([...bulk].sort());
  const onB = new Set((await tasksOf(b)).map((task) => task.id));
  expect(bulk.every((id) => onB.has(id))).toBe(true);

  // Cap-sized Ukrainian rows (about 52 KB each): the byte bound splits the page before 200 rows.
  const big = (await request(a, "/test/bulk", "POST", { project: key, count: 12, text: "Ю".repeat(6_000), details: "Ї".repeat(20_000) })).body.ids as string[];
  await sync(a, peerId);
  const calls = await captured(b);
  const bigPages = pushPages(calls);
  expect(bigPages.length).toBeGreaterThan(1);
  expect(bigPages.flat()).toHaveLength(12);
  expect(new Set(bigPages.flat())).toEqual(new Set(big));
  for (const call of calls) {
    const rows = (JSON.parse(call.request) as { push?: { rows?: unknown[] } }).push?.rows ?? [];
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(512 * 1024);
  }
  for (const id of big) expect((await taskOn(b, id))?.details).toBe("Ї".repeat(20_000));
}, 120_000);

test("with B's clock 7 minutes ahead an edit A makes after receiving B's edit still wins; a stamp 2 hours ahead pauses with clock and applies nothing", async () => {
  const a = await install("clock-A");
  const b = await install("clock-B");
  const peerId = await link(a, b);
  expect((await request(b, "/test/clock?offset=420000")).status).toBe(200);
  const task = await createOn(b, "Clocked");
  await sync(a, peerId);
  expect((await patchOn(b, task.id, { status: "blocked" })).status).toBe(200);
  await sync(a, peerId);
  expect((await taskOn(a, task.id))!.status).toBe("blocked");
  expect((await patchOn(a, task.id, { status: "done" })).status).toBe(200);
  await sync(a, peerId);
  expect((await taskOn(b, task.id))!.status).toBe("done");
  expect((await taskOn(a, task.id))!.status).toBe("done");

  expect((await request(b, "/test/clock?offset=7200000")).status).toBe(200);
  const ahead = await createOn(b, "From two hours ahead");
  const answer = await request(a, `/api/links/peers/${peerId}`, "POST");
  expect(answer.body.error).toBe("clock");
  expect(await taskOn(a, ahead.id)).toBeUndefined();
}, 60_000);

test("a stored task with a 530 000-character repository is withheld while later rows arrive; a forced resync keeps it; its next valid write and its delete cross", async () => {
  const a = await install("bounds-A");
  const b = await install("bounds-B");
  const peerId = await link(a, b);
  const oversize = await createOn(a, "Carries an old link");
  await request(a, "/test/raw", "POST", { id: oversize.id, fields: { workLinks: [{ repository: `acme/${"r".repeat(530_000)}`, number: 7, kind: "pr", addedAt: "2026-09-28T00:00:00.000Z", addedBy: "operator" }] } });
  const later = await createOn(a, "Written after it");
  await captured(b);
  await sync(a, peerId);
  expect(await taskOn(b, oversize.id)).toBeUndefined();
  expect((await taskOn(b, later.id))?.text).toBe("Written after it");
  const bodies = (await captured(b)).map((call) => call.request);
  expect(bodies.some((body) => body.includes(`"withheld"`) && body.includes(oversize.id))).toBe(true);
  expect(Math.max(...bodies.map((body) => Buffer.byteLength(body)))).toBeLessThan(700 * 1024);
  // update_task refuses such a link.
  expect((await patchOn(a, later.id, { attachLinks: `acme/${"r".repeat(101)}#1` })).status).toBe(400);

  // A recreated store on B: both directions rebuild; the task stays on A.
  await request(b, "/test/new-store", "POST");
  await sync(a, peerId);
  expect((await taskOn(a, oversize.id))?.text).toBe("Carries an old link");
  expect((await taskOn(b, later.id))?.text).toBe("Written after it");

  await request(a, "/test/raw", "POST", { id: oversize.id, fields: { workLinks: [{ repository: "acme/widget", number: 7, kind: "pr", addedAt: "2026-09-28T00:00:00.000Z", addedBy: "operator" }] } });
  await sync(a, peerId);
  expect((await taskOn(b, oversize.id))?.workLinks?.[0]?.repository).toBe("acme/widget");
  expect((await request(a, `/api/tasks/${oversize.id}`, "DELETE")).status).toBe(200);
  await sync(a, peerId);
  expect(await taskOn(b, oversize.id)).toBeUndefined();
}, 60_000);

test("one edit costs its encoded row plus at most 300 bytes with 1 000 linked projects, and cap-sized rows cross", async () => {
  const remotes: Record<string, string> = {};
  for (let index = 0; index < 999; index++) {
    const name = `code.example.test/acme/widget-${index}`;
    remotes[projectIdentityFromRemote(`https://${name}`, "/")!.project] = name;
  }
  const a = await install("bytes-A", remotes);
  const b = await install("bytes-B", remotes);
  const wire = await meter(b);
  meters.push(wire);
  const peerId = await link(a, b, { all: true }, wire.url);
  const task = await createOn(a, "Measured task");
  await sync(a, peerId);
  await sync(a, peerId);
  expect((await taskOn(b, task.id))?.text).toBe("Measured task");

  // Every byte of every call on the wire, headers included.
  const measure = async (run: () => Promise<void>) => {
    const start = { connections: wire.connections, bytes: wire.up + wire.down };
    await run();
    return { calls: wire.connections - start.connections, bytes: wire.up + wire.down - start.bytes };
  };
  const edited = await measure(async () => {
    expect((await patchOn(a, task.id, { status: "blocked" })).status).toBe(200);
    await sync(a, peerId);
    await sync(a, peerId);
  });
  const idle = await measure(async () => { for (let i = 0; i < edited.calls; i++) await sync(a, peerId); });
  const row = (await captured(b, false), (await tasksOf(a)).find((candidate) => candidate.id === task.id)!);
  expect(row.status).toBe("blocked");
  expect((await taskOn(b, task.id))!.status).toBe("blocked");
  // The encoded row as it crossed, read back from the push that carried it.
  const pushBytes = await (async () => {
    await captured(b);
    expect((await patchOn(a, task.id, { status: "done" })).status).toBe(200);
    await sync(a, peerId);
    const push = (await captured(b)).map((call) => JSON.parse(call.request) as { push?: { rows?: unknown[] } }).find((body) => body.push?.rows?.length);
    return Buffer.byteLength(JSON.stringify(push!.push!.rows![0]));
  })();
  expect(edited.bytes - idle.bytes).toBeLessThanOrEqual(pushBytes + 300);

  // Cap-sized Ukrainian text and details, and a row of control characters
  // with 20 links at the length bound, both cross.
  const ukrainian = await createOn(a, "Ї".repeat(6_000), { details: "Є".repeat(20_000) });
  const control = await createOn(a, "\u0001".repeat(6_000), { details: "\u0002".repeat(20_000) });
  await request(a, "/test/raw", "POST", { id: control.id, fields: { workLinks: Array.from({ length: 20 }, (_, index) => ({ repository: `${"o".repeat(39)}/${"r".repeat(100)}`, number: index + 1, kind: "pr", addedAt: "2026-09-28T00:00:00.000Z", addedBy: "operator" })) } });
  await sync(a, peerId);
  expect((await taskOn(b, ukrainian.id))?.details?.length).toBe(20_000);
  expect((await taskOn(b, control.id))?.workLinks).toHaveLength(20);
}, 180_000);

test("a forged owner is dropped: A's token cannot give B's task to A or hand it to a third install, whatever the stamp", async () => {
  const { sharedDigest } = await import("./protocol");
  const a = await install("forged-A");
  const b = await install("forged-B");
  const peerId = await link(a, b);
  const task = await createOn(b, "Runs on B");
  await sync(a, peerId);
  const onA = (await taskOn(a, task.id))!;
  const bInstall = onA.machine!;
  const aSelf = JSON.parse(fs.readFileSync(path.join(root, "forged-A", "links/self.json"), "utf8")) as { installId: string };
  const stored = JSON.parse(fs.readFileSync(path.join(root, "forged-A", "links/peers.json"), "utf8")).peers[0] as { token: string; grantId: string };
  const list = [{ key, name: "widget" }];
  const later = `${String(Date.now() + 60_000).padStart(13, "0")}.000.${bInstall.replace(/-/g, "").slice(0, 8)}`;
  const row = (fields: Record<string, unknown>) => ({ id: task.id, project: key, text: "Runs on B", status: "inbox", placement: "unplaced",
    machine: bInstall, createdAt: onA.createdAt, updatedAt: onA.updatedAt,
    s: { ...onA.sync!.s, machine: later, handover: later }, ...fields });
  for (const forged of [row({ machine: aSelf.installId }), row({ handover: { to: ["0c0c0c0c", "3333", "4333", "8333", "333333333333"].join("-") } })]) {
    const answer = await fetch(`${b}/api/peer/v1/boards/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-delegatus-peer": `${stored.grantId}.${stored.token}` },
      body: JSON.stringify({ v: 1, store: ["00000000", "0000", "4000", "8000", "000000000000"].join("-"), now: Date.now(), s: sharedDigest(list), have: sharedDigest(list), push: { rows: [forged], through: [1] } }),
    });
    expect(answer.status).toBe(200);
    // B took the page (the lists agreed) and acknowledged it after its commit.
    expect(((await answer.json()) as { ack?: { push?: unknown } }).ack?.push).toEqual([1]);
  }
  const onB = (await taskOn(b, task.id))!;
  expect(onB.machine).toBe(bInstall);
  expect(onB.handover).toBeUndefined();
  expect((await request(b, `/test/runs-here?id=${task.id}`)).body.refusal).toBeNull();
  expect(((await request(a, `/test/runs-here?id=${task.id}`)).body.refusal as { code: string }).code).toBe("TASK_RUNS_ELSEWHERE");
}, 60_000);

test("a reinstalled peer receives the tasks of its earlier install with their old owner, and neither machine launches them", async () => {
  const a = await install("reinstall-A");
  const b = await install("reinstall-B");
  const peerId = await link(a, b);
  const task = await createOn(b, "Owned by the first install");
  await sync(a, peerId);
  const oldOwner = (await taskOn(a, task.id))!.machine!;
  expect((await request(a, `/api/links/peers/${peerId}`, "DELETE")).status).toBe(200);
  const b2 = await install("reinstall-B2");
  const secondPeer = await link(a, b2);
  await sync(a, secondPeer);
  const received = (await taskOn(b2, task.id))!;
  expect(received.machine).toBe(oldOwner);
  const refusedOnB2 = (await request(b2, `/test/runs-here?id=${task.id}`)).body.refusal as { code: string; error: string };
  const refusedOnA = (await request(a, `/test/runs-here?id=${task.id}`)).body.refusal as { code: string; error: string };
  expect(refusedOnB2.code).toBe("TASK_RUNS_ELSEWHERE");
  expect(refusedOnA.code).toBe("TASK_RUNS_ELSEWHERE");
  expect(refusedOnA.error).toContain("which is not linked");
  // The refusal names the owner only; it points at no control this slice lacks.
  for (const refusal of [refusedOnA, refusedOnB2]) expect(refusal.error).not.toMatch(/Run here|Copy here|copy is made/);
}, 60_000);

type Figures = { rowReads: number; writes: number; revisions: Record<string, number | null>; bytes: Record<string, { rows: number; bytes: number; largest: number }>; changes: Record<string, number> };
const figures = async (base: string, reset = false) => (await request(base, `/test/store${reset ? "?reset=1" : ""}`)).body as unknown as Figures;
const otherRemote = "code.example.test/acme/unlinked";
const otherKey = projectIdentityFromRemote(`https://${otherRemote}`, "/")!.project;

test("2 000 expired Done omissions per install keep unchanged idle syncs within the zero-read and 2 ms CPU budgets", async () => {
  const installs = [await install("expired-idle-A"), await install("expired-idle-B")];
  const doneAt = new Date(Date.now() - DONE_TASK_BOARD_RETENTION_MS - 60_000).toISOString();
  for (const side of installs) {
    await request(side, "/test/capture?on=0");
    await request(side, "/test/bulk", "POST", { project: key, count: 2_000 });
    const completed = (await tasksOf(side)).map((task) => ({ ...task, status: "done" }));
    expect((await request(side, "/test/import-tasks", "POST", { tasks: completed })).status).toBe(200);
    // The transition stamps completion; backdate the already-Done fixture.
    const expired = (await tasksOf(side)).map((task) => ({ ...task, doneAt, doneAdmissions: [] }));
    expect((await request(side, "/test/import-tasks", "POST", { tasks: expired })).status).toBe(200);
    expect((await tasksOf(side)).every((task) => task.doneAt === doneAt)).toBe(true);
  }
  const peerId = await link(installs[0]!, installs[1]!);
  for (let i = 0; i < 100; i++) await sync(installs[0]!, peerId);
  const before = await Promise.all(installs.map((side) => figures(side, true)));
  const cpu = () => Promise.all(installs.map(async (side) => (await request(side, "/test/cpu")).body.ms as number));
  const cpuBefore = await cpu();
  for (let i = 0; i < 100; i++) await sync(installs[0]!, peerId);
  const cpuAfter = await cpu();
  const idle = await Promise.all(installs.map((side) => figures(side)));
  console.info("Expired Done idle CPU per 100 syncs (ms):", cpuAfter.map((after, side) => after - cpuBefore[side]!));
  for (const side of [0, 1]) {
    expect({ side, rowReads: idle[side]!.rowReads, writes: idle[side]!.writes }).toEqual({ side, rowReads: 0, writes: 0 });
    expect(idle[side]!.revisions).toEqual(before[side]!.revisions);
    expect(cpuAfter[side]! - cpuBefore[side]!).toBeLessThanOrEqual(200);
    expect(await tasksOf(installs[side]!)).toHaveLength(2_000);
  }
  // A changed scanner snapshot starts bounded work even when no task row
  // changed. Four calls cover all 2 000 omissions, then idle reads stop again.
  for (const side of installs) await request(side, "/test/scan");
  for (let i = 0; i < 4; i++) {
    await Promise.all(installs.map((side) => figures(side, true)));
    await sync(installs[0]!, peerId);
    for (const side of installs) {
      const work = await figures(side);
      expect(work.rowReads).toBeGreaterThan(0);
      expect(work.rowReads).toBeLessThanOrEqual(513);
      expect(work.writes).toBe(0);
    }
  }
  await Promise.all(installs.map((side) => figures(side, true)));
  await sync(installs[0]!, peerId);
  for (const side of installs) expect((await figures(side)).rowReads).toBe(0);
}, 60_000);

test("idle calls read no task row and write nothing on either side; 100 calls while an unlinked project takes writes cost at most one board_links write", async () => {
  const a = await install("work-A", { [otherKey]: otherRemote });
  const b = await install("work-B", { [otherKey]: otherRemote });
  await request(a, "/test/bulk", "POST", { project: key, count: 50 });
  await request(b, "/test/bulk", "POST", { project: key, count: 50 });
  const peerId = await link(a, b);
  // Edits and deletes on both sides have synced before the idle run starts.
  const fromA = await createOn(a, "Made on A");
  const fromB = await createOn(b, "Made on B");
  await sync(a, peerId);
  expect((await patchOn(a, fromB.id, { status: "blocked" })).status).toBe(200);
  expect((await request(b, `/api/tasks/${fromA.id}`, "DELETE")).status).toBe(200);
  await sync(a, peerId);
  await sync(a, peerId);
  expect(await taskOn(a, fromA.id)).toBeUndefined();
  expect((await taskOn(b, fromB.id))?.status).toBe("blocked");

  const before = await Promise.all([figures(a, true), figures(b, true)]);
  for (let i = 0; i < 100; i++) await sync(a, peerId);
  const idle = await Promise.all([figures(a), figures(b)]);
  for (const side of [0, 1]) {
    expect([side, idle[side]!.rowReads, idle[side]!.writes]).toEqual([side, 0, 0]);
    expect(idle[side]!.revisions).toEqual(before[side]!.revisions);
  }

  // Another project takes a write on both sides before every call: the
  // cursors pass it in memory and the linked rows stay where they are.
  await captured(b);
  for (let i = 0; i < 100; i++) {
    for (const side of [a, b]) await request(side, "/test/bulk", "POST", { project: otherKey, count: 1 });
    await sync(a, peerId);
  }
  const busy = await Promise.all([figures(a), figures(b)]);
  for (const side of [0, 1]) {
    // The same spies see the other project's writes, so the zeros above are real.
    expect(busy[side]!.writes).toBeGreaterThan(0);
    expect(busy[side]!.revisions.tasks! - idle[side]!.revisions.tasks!).toBe(100);
    expect(busy[side]!.revisions.board_links! - idle[side]!.revisions.board_links!).toBeLessThanOrEqual(1);
    expect(busy[side]!.revisions.task_tombstones).toEqual(idle[side]!.revisions.task_tombstones);
  }
  for (const call of await captured(b)) {
    const sent = JSON.parse(call.request) as { push?: { rows?: unknown[] } };
    const answered = JSON.parse(call.response) as { tasks?: { rows?: unknown[] } };
    expect([sent.push?.rows?.length ?? 0, answered.tasks?.rows?.length ?? 0]).toEqual([0, 0]);
  }
  // Ten minutes on, the cursor that only passed other projects is saved once.
  await request(a, `/test/clock?offset=${11 * 60_000}`);
  const saved = (await figures(a)).revisions.board_links!;
  await request(a, "/test/bulk", "POST", { project: otherKey, count: 1 });
  await sync(a, peerId);
  await sync(a, peerId);
  expect((await figures(a)).revisions.board_links! - saved).toBe(1);
}, 120_000);

test("each applied page commits one tasks revision and at most one board_links revision; a delete writes its tombstone in the same commit", async () => {
  const a = await install("disk-A");
  const b = await install("disk-B");
  const peerId = await link(a, b);
  const task = await createOn(a, "Measured task");
  await sync(a, peerId);
  await sync(a, peerId);
  const change = async (run: () => Promise<void>) => {
    const start = await Promise.all([figures(a), figures(b)]);
    await captured(b);
    await run();
    const end = await Promise.all([figures(a), figures(b)]);
    const calls = await captured(b);
    const delta = (side: number, name: string) => end[side]!.revisions[name]! - (start[side]!.revisions[name] ?? 0);
    return {
      pulled: calls.filter((call) => (JSON.parse(call.response) as { tasks?: { rows?: unknown[] } }).tasks?.rows?.length).length,
      pushed: calls.filter((call) => (JSON.parse(call.request) as { push?: { rows?: unknown[] } }).push?.rows?.length).length,
      a: { tasks: delta(0, "tasks"), links: delta(0, "board_links"), tombstones: delta(0, "task_tombstones") },
      b: { tasks: delta(1, "tasks"), links: delta(1, "board_links"), tombstones: delta(1, "task_tombstones") },
      end,
    };
  };

  // B's edit reaches A as one page.
  const pulled = await change(async () => {
    expect((await patchOn(b, task.id, { status: "blocked" })).status).toBe(200);
    await sync(a, peerId);
  });
  expect(pulled.pulled).toBe(1);
  expect(pulled.a.tasks).toBe(1);
  expect(pulled.a.links).toBeLessThanOrEqual(1);
  expect(pulled.b.tasks).toBe(1); // B's own edit
  expect(pulled.b.links).toBe(0);

  // A's edit reaches B as one page.
  const pushed = await change(async () => {
    expect((await patchOn(a, task.id, { text: "Renamed on A" })).status).toBe(200);
    await sync(a, peerId);
  });
  expect(pushed.pushed).toBe(1);
  expect(pushed.b.tasks).toBe(1);
  expect(pushed.b.links).toBe(0);
  expect(pushed.a.tasks).toBe(1); // A's own edit
  expect(pushed.a.links).toBeLessThanOrEqual(1);

  // One transaction of 201 tasks on B reaches A as two pages: one commit each.
  const paged = await change(async () => {
    await request(b, "/test/bulk", "POST", { project: key, count: 201 });
    await sync(a, peerId);
  });
  expect(paged.pulled).toBe(2);
  expect(paged.a.tasks).toBe(2);
  expect(paged.a.links).toBeLessThanOrEqual(2);

  // A delete on A: B commits the removal and its tombstone together.
  const deleted = await change(async () => {
    expect((await request(a, `/api/tasks/${task.id}`, "DELETE")).status).toBe(200);
    await sync(a, peerId);
  });
  expect(deleted.pushed).toBe(1);
  expect(deleted.b.tasks).toBe(1);
  expect(deleted.b.tombstones).toBe(1);
  expect(deleted.b.links).toBe(0);
  expect(await taskOn(b, task.id)).toBeUndefined();
  for (const side of deleted.end) expect(side.bytes.task_tombstones!.largest).toBeLessThanOrEqual(200);
}, 120_000);

test("1 000 synced edits and 100 deletes grow the two new collections by at most 20 KB on each side", async () => {
  const a = await install("growth-A");
  const b = await install("growth-B");
  const ids = (await request(a, "/test/bulk", "POST", { project: key, count: 100 })).body.ids as string[];
  const peerId = await link(a, b);
  await sync(a, peerId);
  for (const side of [a, b]) await request(side, "/test/capture?on=0");
  const start = await Promise.all([figures(a), figures(b)]);
  const statuses = ["assigned", "blocked", "done", "inbox"];
  for (let i = 0; i < 1_000; i++) {
    expect((await patchOn(i % 2 ? b : a, ids[i % ids.length]!, { status: statuses[i % statuses.length] })).status).toBe(200);
    await sync(a, peerId);
  }
  for (let i = 0; i < 100; i++) {
    expect((await request(i % 2 ? b : a, `/api/tasks/${ids[i]}`, "DELETE")).status).toBe(200);
    await sync(a, peerId);
  }
  await sync(a, peerId);
  for (const side of [a, b]) expect((await tasksOf(side)).filter((task) => task.project === key)).toHaveLength(0);
  const end = await Promise.all([figures(a), figures(b)]);
  const grown = end.map((side, index) => ["board_links", "task_tombstones"].reduce((sum, name) => sum + side.bytes[name]!.bytes - (start[index]!.bytes[name]?.bytes ?? 0), 0));
  for (const [index, side] of end.entries()) {
    expect(side.bytes.task_tombstones!.rows).toBeGreaterThanOrEqual(100);
    expect(grown[index]!).toBeLessThanOrEqual(20 * 1024);
  }
}, 300_000);

test("a sync body of 1 MiB + 1 B or a shared page of 101 entries is malformed and applies nothing, in both directions", async () => {
  const a = await install("caps-A");
  const b = await install("caps-B");
  const peerId = await link(a, b);
  const task = await createOn(a, "Before");
  await sync(a, peerId);
  await sync(a, peerId);
  expect((await taskOn(b, task.id))?.text).toBe("Before");

  // The body A would send for an edit, kept by B while it refuses the call.
  expect((await patchOn(a, task.id, { text: "Pushed edit" })).status).toBe(200);
  await captured(b);
  await request(b, "/test/fail-sync?on=1");
  expect((await request(a, `/api/links/peers/${peerId}`, "POST")).status).toBe(409);
  await request(b, "/test/fail-sync?on=0");
  const held = (await captured(b)).map((call) => call.request).find((body) => (JSON.parse(body) as { push?: { rows?: unknown[] } }).push?.rows?.length)!;
  expect(held).toBeDefined();
  const stored = JSON.parse(fs.readFileSync(path.join(root, "caps-A", "links/peers.json"), "utf8")).peers[0] as { token: string; grantId: string };
  const send = (body: string) => fetch(b + "/api/peer/v1/boards/sync", { method: "POST", body,
    headers: { "content-type": "application/json", "x-delegatus-peer": `${stored.grantId}.${stored.token}` } });
  const revision = (await figures(b)).revisions;

  const padded = held + " ".repeat(1_048_577 - Buffer.byteLength(held));
  expect(Buffer.byteLength(padded)).toBe(1_048_577);
  const tooLarge = await send(padded);
  expect([tooLarge.status, await tooLarge.json()]).toEqual([400, { error: "malformed" }]);
  const shared = Array.from({ length: 101 }, (_, index) => ({ key: `repo-${index.toString(16).padStart(32, "0")}`, name: `project-${index}` }));
  const tooMany = await send(JSON.stringify({ ...JSON.parse(held), shared, index: 0, total: 101 }));
  expect([tooMany.status, await tooMany.json()]).toEqual([400, { error: "malformed" }]);
  expect((await taskOn(b, task.id))?.text).toBe("Before");
  expect((await figures(b)).revisions).toEqual(revision);
  // The same body within the bounds applies.
  expect((await send(held)).status).toBe(200);
  expect((await taskOn(b, task.id))?.text).toBe("Pushed edit");
  await sync(a, peerId);

  // B's answer of 1 MiB + 1 B: A refuses it unparsed and applies nothing.
  expect((await patchOn(b, task.id, { text: "Pulled edit" })).status).toBe(200);
  const before = (await figures(a)).revisions;
  await request(b, "/test/pad-answer?to=1048577");
  const refused = await request(a, `/api/links/peers/${peerId}`, "POST");
  expect([refused.status, refused.body.error]).toEqual([409, "malformed"]);
  expect((await taskOn(a, task.id))?.text).toBe("Pushed edit");
  expect((await figures(a)).revisions.tasks).toBe(before.tasks);
  await request(b, "/test/pad-answer?to=0");
  await sync(a, peerId);
  expect((await taskOn(a, task.id))?.text).toBe("Pulled edit");
}, 120_000);


test("shared text crosses and already-synced placeholders recover on the next sync with newer edits preserved", async () => {
  const a = await install("title-repair-A");
  const b = await install("title-repair-B");
  const aId = JSON.parse(fs.readFileSync(path.join(root, "title-repair-A/links/self.json"), "utf8")).installId as string;
  const bId = JSON.parse(fs.readFileSync(path.join(root, "title-repair-B/links/self.json"), "utf8")).installId as string;
  const at = new Date(Date.now() - 60_000).toISOString();
  const stamp = (install: string, offset = 0) => `${String(Date.parse(at) + offset).padStart(13, "0")}.000.${installPrefix(install)}`;
  const original = (install: string, text: string): BoardTask => ({ id: randomUUID(), project: key, text, details: "Agent notes already allowed by the design", status: "done", placement: "unplaced", board: "hidden", assignments: [], createdAt: at, updatedAt: at,
    machine: install, sync: { s: Object.fromEntries(["text", "status", "look", "place", "links", "machine", "handover"].map((group) => [group, stamp(install)])), o: installPrefix(install) } });
  const fromA = original(aId, "Перевірити стан стейджу\nТекст задачі з другого рядка");
  const fromB = original(bId, "Restore linked board freshness");
  const edited = original(aId, "Old source title");
  const placeholder = (task: BoardTask) => ({ ...task, text: "Untitled task", chosen: true });
  const kept = { ...placeholder(edited), text: "Later operator title", sync: { ...edited.sync!, s: { ...edited.sync!.s, text: stamp(bId, 1000) }, o: installPrefix(bId) } };
  await request(a, "/test/import-tasks", "POST", { tasks: [fromA, placeholder(fromB), edited] });
  await request(b, "/test/import-tasks", "POST", { tasks: [placeholder(fromA), fromB, kept] });
  const peerId = await link(a, b, { projects: [key] }, b, false);
  // Seed the persisted cursors of an already quiet old-version link. The first
  // upgraded exchange must cover old rows even though its log was consumed.
  const revisionA = Number((await request(a, "/test/revision")).body.revision);
  const revisionB = Number((await request(b, "/test/revision")).body.revision);
  await request(a, "/test/legacy-cursor", "POST", { id: peerId, pull: [revisionB], pushed: [revisionA], projects: [key], wireVersion: 3 });
  await sync(a, peerId);
  expect((await taskOn(b, fromA.id))?.text).toBe(fromA.text);
  expect((await taskOn(a, fromB.id))?.text).toBe(fromB.text);
  expect((await taskOn(b, fromA.id))?.details).toBe(fromA.details);
  expect((await taskOn(b, edited.id))?.text).toBe(kept.text);
  expect((await taskOn(a, edited.id))?.text).toBe(kept.text);
  // New automatic titles use the same production sender, without chosen.
  const added = (await request(a, "/test/bulk", "POST", { project: key, count: 1, text: "New automatic human title", explicit: false })).body.ids as string[];
  await sync(a, peerId);
  expect((await taskOn(b, added[0]!))?.text).toBe("New automatic human title");
  const beforeA = await tasksOf(a), beforeB = await tasksOf(b);
  await sync(a, peerId);
  expect(await tasksOf(a)).toEqual(beforeA);
  expect(await tasksOf(b)).toEqual(beforeB);
  await stopInstall(a);
  const restarted = await install("title-repair-A");
  await captured(b);
  await sync(restarted, peerId);
  expect(await tasksOf(restarted)).toEqual(beforeA);
  expect(await tasksOf(b)).toEqual(beforeB);
  const idlePages = await captured(b);
  expect(idlePages.every((page) => !(JSON.parse(page.request).push?.rows?.length) && !(JSON.parse(page.response).tasks?.rows?.length))).toBe(true);
}, 30_000);

test("an in-flight placeholder repair keeps the source's concurrent title and details through resync and restart", async () => {
  const receiver = await install("title-race-receiver");
  const source = await install("title-race-source");
  const sourceId = JSON.parse(fs.readFileSync(path.join(root, "title-race-source/links/self.json"), "utf8")).installId as string;
  const at = new Date(Date.now() - 60_000).toISOString();
  const stamp = `${String(Date.parse(at)).padStart(13, "0")}.000.${installPrefix(sourceId)}`;
  const task: BoardTask = { id: randomUUID(), project: key, text: "Title from the captured response", details: "Details from the captured response",
    status: "inbox", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at, machine: sourceId,
    sync: { s: Object.fromEntries(["text", "status", "look", "place", "links", "machine", "handover"].map((group) => [group, stamp])), o: installPrefix(sourceId) } };
  const placeholder = { ...task, text: "Untitled task" };
  await request(source, "/test/import-tasks", "POST", { tasks: [task] });
  await request(receiver, "/test/import-tasks", "POST", { tasks: [placeholder] });
  const peerId = await link(receiver, source, { projects: [key] }, source, false);
  const revisionReceiver = Number((await request(receiver, "/test/revision")).body.revision);
  const revisionSource = Number((await request(source, "/test/revision")).body.revision);
  await request(receiver, "/test/legacy-cursor", "POST", { id: peerId, pull: [revisionSource], pushed: [revisionReceiver], projects: [key] });

  await request(source, "/test/hold-sync?side=task-response");
  const inFlight = fetch(`${receiver}/api/links/peers/${peerId}`, { method: "POST" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await request(source, "/test/sync-held")).body.held) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect((await request(source, "/test/sync-held")).body.held).toBe(true);
  expect((await patchOn(source, task.id, { text: "Newer source title", details: "Newer source details" })).status).toBe(200);
  const sourceEdit = (await taskOn(source, task.id))!;
  expect(sourceEdit.text).toBe("Newer source title");
  // Stop the exchange after it consumes the held, stale response. This keeps
  // a later page from hiding whether the repair minted a local text stamp.
  await request(source, "/test/fail-sync?on=1");
  await request(source, "/test/release-sync");
  await inFlight;

  // The delayed reply carries the old title and stamp. Applying it may repair
  // the placeholder, but must not turn old content into a newer local edit.
  const repaired = (await taskOn(receiver, task.id))!;
  expect(repaired).toMatchObject({ text: "Title from the captured response", details: "Details from the captured response" });
  expect(repaired.sync?.s.text).toBe(stamp);
  await request(source, "/test/fail-sync?on=0");
  await sync(receiver, peerId);
  expect(await taskOn(receiver, task.id)).toMatchObject({ text: "Newer source title", details: "Newer source details" });
  expect(await taskOn(source, task.id)).toMatchObject({ text: "Newer source title", details: "Newer source details" });
  const beforeRestart = await tasksOf(receiver);
  await stopInstall(receiver);
  const restarted = await install("title-race-receiver");
  expect(await taskOn(restarted, task.id)).toMatchObject({ text: "Newer source title", details: "Newer source details" });
  await sync(restarted, peerId);
  expect(await tasksOf(restarted)).toEqual(beforeRestart);
}, 60_000);

test("placeholder title repair follows the saved task stamp across a peer reinstall and consumed cursor", async () => {
  const receiver = await install("legacy-title-receiver");
  await install("legacy-title-old-source");
  const oldSourceId = JSON.parse(fs.readFileSync(path.join(root, "legacy-title-old-source/links/self.json"), "utf8")).installId as string;
  const currentSource = await install("legacy-title-new-source");
  const at = new Date(Date.now() - 60_000).toISOString();
  const stamp = `${String(Date.parse(at)).padStart(13, "0")}.000.${installPrefix(oldSourceId)}`;
  const task: BoardTask = { id: randomUUID(), project: key, text: "Title from the previous install", details: "Keep the existing details",
    status: "inbox", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at, machine: oldSourceId,
    sync: { s: Object.fromEntries(["text", "status", "look", "place", "links", "machine", "handover"].map((group) => [group, stamp])), o: installPrefix(oldSourceId) } };
  await request(currentSource, "/test/import-tasks", "POST", { tasks: [task] });
  await request(receiver, "/test/import-tasks", "POST", { tasks: [{ ...task, text: "Untitled task" }] });
  const peerId = await link(receiver, currentSource, { projects: [key] }, currentSource, false);
  const revisionReceiver = Number((await request(receiver, "/test/revision")).body.revision);
  const revisionSource = Number((await request(currentSource, "/test/revision")).body.revision);
  await request(receiver, "/test/legacy-cursor", "POST", { id: peerId, pull: [revisionSource], pushed: [revisionReceiver], projects: [key] });

  await sync(receiver, peerId);
  expect(await taskOn(receiver, task.id)).toMatchObject({ text: "Title from the previous install", details: "Keep the existing details", machine: oldSourceId });
  const repaired = (await taskOn(receiver, task.id))!;
  expect(repaired.sync?.s.text).toBe(stamp);
  await sync(receiver, peerId);
  expect((await taskOn(receiver, task.id))?.text).toBe("Title from the previous install");
}, 60_000);

test("an old peer cannot consume title recovery before its wire upgrade, including across receiver restart", async () => {
  const receiver = await install("rolling-title-receiver");
  const source = await install("rolling-title-source");
  const sourceId = JSON.parse(fs.readFileSync(path.join(root, "rolling-title-source/links/self.json"), "utf8")).installId as string;
  const at = new Date(Date.now() - 60_000).toISOString();
  const stamp = `${String(Date.parse(at)).padStart(13, "0")}.000.${installPrefix(sourceId)}`;
  const task: BoardTask = { id: randomUUID(), project: key, text: "Original automatic title", details: "Shared task details",
    status: "inbox", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at, machine: sourceId,
    sync: { s: Object.fromEntries(["text", "status", "look", "place", "links", "machine", "handover"].map((group) => [group, stamp])), o: installPrefix(sourceId) } };
  const peerId = await link(receiver, source, { projects: [key] }, source, false);
  await request(source, "/test/import-tasks", "POST", { tasks: [task] });
  await request(receiver, "/test/import-tasks", "POST", { tasks: [{ ...task, text: "Untitled task", chosen: true }] });
  await request(source, "/test/capture?on=1");
  await request(source, "/test/legacy-task-wire?on=1");

  await sync(receiver, peerId);
  expect((await taskOn(receiver, task.id))?.text).toBe("Untitled task");
  const oldPeerPages = (await captured(source)).map((call) => JSON.parse(call.response) as { taskWireVersion?: number; tasks?: { rows?: { text?: string }[] } });
  expect(oldPeerPages.some((page) => page.tasks?.rows?.some((row) => row.text === "Untitled task"))).toBe(true);
  expect(oldPeerPages.every((page) => page.taskWireVersion === undefined)).toBe(true);

  await stopInstall(receiver);
  const restarted = await install("rolling-title-receiver");
  expect((await taskOn(restarted, task.id))?.text).toBe("Untitled task");
  await sync(restarted, peerId);
  expect((await taskOn(restarted, task.id))?.text).toBe("Untitled task");

  await request(source, "/test/legacy-task-wire?on=0");
  await sync(restarted, peerId);
  expect(await taskOn(restarted, task.id)).toMatchObject({ text: "Original automatic title", details: "Shared task details", status: "inbox" });
}, 60_000);

test("a receiver upgraded after its sender replays title recovery from its consumed legacy cursor", async () => {
  const receiver = await install("sender-first-title-receiver");
  const source = await install("sender-first-title-source");
  const sourceId = JSON.parse(fs.readFileSync(path.join(root, "sender-first-title-source/links/self.json"), "utf8")).installId as string;
  const at = new Date(Date.now() - 60_000).toISOString();
  const stamp = `${String(Date.parse(at)).padStart(13, "0")}.000.${installPrefix(sourceId)}`;
  const task: BoardTask = { id: randomUUID(), project: key, text: "Sender-first automatic title", details: "Preserve these details",
    status: "blocked", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at, machine: sourceId,
    sync: { s: Object.fromEntries(["text", "status", "look", "place", "links", "machine", "handover"].map((group) => [group, stamp])), o: installPrefix(sourceId) } };
  const peerId = await link(receiver, source, { projects: [key] }, source, false);
  await request(source, "/test/import-tasks", "POST", { tasks: [task] });
  await request(receiver, "/test/import-tasks", "POST", { tasks: [{ ...task, text: "Untitled task", chosen: true }] });
  const revisionReceiver = Number((await request(receiver, "/test/revision")).body.revision);
  const revisionSource = Number((await request(source, "/test/revision")).body.revision);
  await request(receiver, "/test/legacy-cursor", "POST", { id: peerId, pull: [revisionSource], pushed: [revisionReceiver], projects: [key] });

  await stopInstall(receiver);
  const upgradedReceiver = await install("sender-first-title-receiver");
  await sync(upgradedReceiver, peerId);
  expect(await taskOn(upgradedReceiver, task.id)).toMatchObject({ text: "Sender-first automatic title", details: "Preserve these details", status: "blocked" });
}, 60_000);

for (const upgradeInitiator of [false, true]) {
  test(`consumed v3 title recovery survives an ${upgradeInitiator ? "initiating" : "accepting"}-only upgrade and restart`, async () => {
    const legacy = mergeBaseSource("7b5cc5fe");
    const names = [`title-v3-A-${upgradeInitiator}`, `title-v3-B-${upgradeInitiator}`];
    let a = await install(names[0]!, {}, legacy), b = await install(names[1]!, {}, legacy);
    const fromA = await createOn(a, "Authoritative initiating title");
    const fromB = await createOn(b, "Authoritative accepting title");
    const edited = await createOn(a, "Older owner title");
    const peerId = await link(a, b);
    await sync(a, peerId);
    const saved = await Promise.all([tasksOf(a), tasksOf(b)]);
    await stopInstall(a);
    await stopInstall(b);
    const bInstallId = JSON.parse(fs.readFileSync(path.join(root, names[1]!, "links/self.json"), "utf8")).installId as string;
    const newerTextStamp = `${String(Date.now()).padStart(13, "0")}.999.${installPrefix(bInstallId)}`;
    // Reproduce the persisted equal-stamp loss without advancing the log or
    // resetting cursors. Both directions have already consumed real v3 feeds.
    for (const [side, name] of names.entries()) {
      const db = new Database(path.join(root, name, "state.sqlite"));
      try {
        if (side === 0) {
          const cursor = db.query<{ value_json: string }, [string]>("SELECT value_json FROM state_rows WHERE collection = 'board_links' AND row_key = ?").get(`tasks:${peerId}`)!;
          expect(JSON.parse(cursor.value_json)).toMatchObject({ taskWireVersion: 3, cursor: { boardReplayVersion: 1 } });
        }
        const lostId = side === 0 ? fromB.id : fromA.id;
        for (const task of saved[side]!) {
          if (task.id === lostId) task.text = "Untitled task";
          else if (side === 1 && task.id === edited.id) {
            task.text = "Newer local title";
            task.sync!.s.text = newerTextStamp;
          } else continue;
          db.query("UPDATE state_rows SET value_json = ? WHERE collection = 'tasks' AND row_key = ?").run(JSON.stringify(task), `t:${task.id}`);
        }
      } finally { db.close(); }
    }
    a = await install(names[0]!, {}, upgradeInitiator ? process.cwd() : legacy);
    b = await install(names[1]!, {}, upgradeInitiator ? legacy : process.cwd());
    expect((await taskOn(b, fromA.id))?.text).toBe("Untitled task");
    expect((await taskOn(a, fromB.id))?.text).toBe("Untitled task");
    await sync(a, peerId);
    await sync(a, peerId);
    expect(await taskOn(b, fromA.id)).toMatchObject({ text: fromA.text, sync: { s: { text: saved[1]!.find((task) => task.id === fromA.id)!.sync!.s.text } } });
    expect(await taskOn(a, fromB.id)).toMatchObject({ text: fromB.text, sync: { s: { text: saved[0]!.find((task) => task.id === fromB.id)!.sync!.s.text } } });
    expect(await taskOn(b, edited.id)).toMatchObject({ text: "Newer local title", sync: { s: { text: newerTextStamp } } });
    await stopInstall(a);
    await stopInstall(b);
    a = await install(names[0]!, {}, upgradeInitiator ? process.cwd() : legacy);
    b = await install(names[1]!, {}, upgradeInitiator ? legacy : process.cwd());
    const before = await Promise.all([tasksOf(a), tasksOf(b)]);
    await request(b, "/test/capture?on=1");
    for (let i = 0; i < 3; i++) await sync(a, peerId);
    expect(await Promise.all([tasksOf(a), tasksOf(b)])).toEqual(before);
    for (const call of await captured(b)) {
      expect(JSON.parse(call.request).push?.rows ?? []).toEqual([]);
      expect(JSON.parse(call.response).tasks?.rows ?? []).toEqual([]);
    }
  }, 60_000);
}

test("task wire v3 keeps board sync compatible with a strict v2 peer in both upgrade orders", async () => {
  let current = await install("rolling-board-current");
  const legacy = await install("rolling-board-legacy");
  await request(legacy, "/test/legacy-task-wire?on=1");
  const currentToLegacy = await link(current, legacy, { projects: [key] }, legacy, false);
  const hidden = await createOn(current, "Hidden while peer is old", { board: "hidden" });
  const shown = await createOn(current, "Shown while peer is old", { board: "shown" });
  await sync(current, currentToLegacy);
  expect((await taskOn(legacy, hidden.id))?.text).toBe(hidden.text);
  expect((await taskOn(legacy, shown.id))?.text).toBe(shown.text);
  const legacyRequests = await captured(legacy);
  const sentRows = legacyRequests.flatMap((call) => {
    const body = JSON.parse(call.request) as { push?: { rows?: Record<string, unknown>[] } };
    return body.push?.rows ?? [];
  });
  expect(sentRows.some((row) => row.id === hidden.id)).toBe(true);
  expect(sentRows.filter((row) => row.id === hidden.id || row.id === shown.id).every((row) => !("board" in row))).toBe(true);

  // The old client sends the merge-base request shape (no taskWireVersion).
  // The current production route must return rows its strict decoder accepts.
  await request(current, "/test/capture?on=1");
  await link(legacy, current, { projects: [key] }, current, false);
  const calls = await captured(current);
  const template = JSON.parse(calls.at(-1)!.request) as Record<string, unknown>;
  template.taskWireVersion = 3;
  template.tasks = { after: null, scan: { p: [key], after: "" } };
  const legacyPeer = (JSON.parse(fs.readFileSync(path.join(root, "rolling-board-legacy", "links/peers.json"), "utf8")) as { peers: { url: string; grantId: string; token: string }[] }).peers
    .find((peer) => peer.url === current)!;
  const postAsLegacy = (wire: Record<string, unknown>) => fetch(`${current}/api/peer/v1/boards/sync`, { method: "POST", headers: {
    "content-type": "application/json", "x-delegatus-peer": `${legacyPeer.grantId}.${legacyPeer.token}`,
  }, body: JSON.stringify(wire) });
  const modernResponse = await postAsLegacy(template);
  expect(modernResponse.status).toBe(200);
  const modernAnswer = await modernResponse.json() as { tasks?: { rows?: Record<string, unknown>[] } };
  const modernRows = modernAnswer.tasks?.rows ?? [];
  expect(modernRows.find((row) => row.id === hidden.id)?.board).toBe("hidden");
  expect(modernRows.find((row) => row.id === shown.id)?.board).toBe("shown");

  // An old client sends the same scan without advertising board support.
  const oldRequest = { ...template };
  delete oldRequest.taskWireVersion;
  const response = await postAsLegacy(oldRequest);
  expect(response.status).toBe(200);
  const answer = await response.json() as { tasks?: { rows?: Record<string, unknown>[] } };
  const oldClientRows = answer.tasks?.rows ?? [];
  expect(oldClientRows.map((row) => row.id)).toContain(hidden.id);
  expect(oldClientRows.map((row) => row.id)).toContain(shown.id);
  for (const row of oldClientRows) decodeLegacyTaskRow(row);
  expect(oldClientRows.find((row) => row.id === hidden.id)?.text).toBe(hidden.text);

  // Restart the upgraded sender, then verify the peer's v3 confirmation
  // replays the rows omitted during the old-peer interval without losing them.
  await request(legacy, "/test/legacy-task-wire?on=0");
  await stopInstall(current);
  current = await install("rolling-board-current");
  await sync(current, currentToLegacy);
  expect(await taskOn(legacy, hidden.id)).toMatchObject({ text: hidden.text, board: "hidden" });
  expect(await taskOn(legacy, shown.id)).toMatchObject({ text: shown.text, board: "shown" });
  expect((await tasksOf(legacy)).filter((task) => task.id === hidden.id || task.id === shown.id)).toHaveLength(2);
}, 60_000);


test("fresh v3 linking replays pre-confirmation membership and persists it across restart", async () => {
  let a = await install("fresh-membership-A");
  let b = await install("fresh-membership-B");
  const hidden = await createOn(a, "Pre-existing hidden", { board: "hidden", details: "Keep the original details" });
  expect((await patchOn(a, hidden.id, { color: "sky" })).status).toBe(200);
  const peerId = await link(a, b);
  await sync(a, peerId);
  const beforeRestart = await taskOn(b, hidden.id);
  await stopInstall(a);
  a = await install("fresh-membership-A");
  await sync(a, peerId);
  await stopInstall(b);
  b = await install("fresh-membership-B");
  expect(await taskOn(b, hidden.id)).toMatchObject({ text: hidden.text, details: hidden.details, color: "sky", board: "hidden" });
  expect(beforeRestart?.board).toBe("hidden");
  expect(taskShowsOnBoard((await taskOn(b, hidden.id))!, false)).toBe(false);
  expect(await tasksOf(b)).toHaveLength(1);
}, 60_000);

test("an affected merge-base v3 cursor replays pre-confirmation membership once after upgrade", async () => {
  const base = mergeBaseSource();
  let a = await install("persisted-v3-A", {}, base);
  let b = await install("persisted-v3-B", {}, base);
  const hidden = await createOn(a, "Pre-existing hidden on merge base", { board: "hidden", details: "Preserve these details" });
  const peerId = await link(a, b, { projects: [key] });
  await sync(a, peerId);
  await sync(a, peerId);
  const missed = await taskOn(b, hidden.id);
  expect(missed).toMatchObject({ text: hidden.text, details: hidden.details });
  expect(missed?.board).toBeUndefined();

  await stopInstall(a);
  await stopInstall(b);
  a = await install("persisted-v3-A");
  b = await install("persisted-v3-B");
  await sync(a, peerId);
  await sync(a, peerId);
  expect(await taskOn(b, hidden.id)).toMatchObject({ board: "hidden", text: hidden.text, details: hidden.details });
  expect(await tasksOf(b)).toHaveLength(1);
  const recoveredRevision = await request(b, "/test/revision");
  await stopInstall(a);
  await stopInstall(b);
  a = await install("persisted-v3-A");
  b = await install("persisted-v3-B");
  await sync(a, peerId);
  expect(await taskOn(b, hidden.id)).toMatchObject({ board: "hidden", text: hidden.text, details: hidden.details });
  expect(await request(b, "/test/revision")).toEqual(recoveredRevision);
}, 60_000);

for (const upgradeAFirst of [false, true]) {
  test(`merge-base automatic done-task hide recovers after mixed-version upgrade (${upgradeAFirst ? "A first" : "B first"})`, async () => {
    const base = mergeBaseSource();
    let a = await install(`legacy-hide-A-${upgradeAFirst}`, {}, base);
    let b = await install(`legacy-hide-B-${upgradeAFirst}`, {}, oldSource());
    const via = await meter(b);
    meters.push(via);
    const peerId = await link(a, b, { projects: [key] }, via.url);
    const shown = await createOn(b, "Shown done from the old stage", { board: "shown", details: "Keep this payload", color: "sky" });
    expect((await patchOn(b, shown.id, { status: "done" })).status).toBe(200);
    const explicit = await createOn(b, "Keep an explicit local hide", { board: "shown", details: "Choice stays local" });
    expect((await patchOn(b, explicit.id, { status: "done" })).status).toBe(200);
    await sync(a, peerId);
    const damaged = await taskOn(a, shown.id);
    expect(damaged).toMatchObject({ board: "hidden", status: "done", details: "Keep this payload", color: "sky" });
    expect(damaged?.boardAutoHidden).toBeUndefined();

    // A real operator choice made after upgrade remains protected on replay.
    if (upgradeAFirst) {
      await stopInstall(a);
      a = await install(`legacy-hide-A-${upgradeAFirst}`);
      expect((await patchOn(a, explicit.id, { board: "hidden" })).status).toBe(200);
      await sync(a, peerId);
      await stopInstall(b);
      b = await install(`legacy-hide-B-${upgradeAFirst}`);
      via.retarget(b);
    } else {
      await stopInstall(b);
      b = await install(`legacy-hide-B-${upgradeAFirst}`);
      via.retarget(b);
      await stopInstall(a);
      a = await install(`legacy-hide-A-${upgradeAFirst}`);
      expect((await patchOn(a, explicit.id, { board: "hidden" })).status).toBe(200);
    }
    await sync(a, peerId);
    await sync(a, peerId);
    expect(await taskOn(a, shown.id)).toMatchObject({ board: "shown", status: "done", details: "Keep this payload", color: "sky" });
    expect(await taskOn(a, explicit.id)).toMatchObject({ board: "hidden", status: "done", details: "Choice stays local" });
    expect(await tasksOf(a)).toHaveLength(2);
    expect(await tasksOf(b)).toHaveLength(2);

    // The recovered preference survives a later owner edit and idle replay.
    expect((await patchOn(b, shown.id, { details: "Owner edit after upgrade" })).status).toBe(200);
    await sync(a, peerId);
    await sync(a, peerId);
    expect(await taskOn(a, shown.id)).toMatchObject({ board: "shown", details: "Owner edit after upgrade", status: "done" });
    expect(await taskOn(b, shown.id)).toMatchObject({ board: "shown", details: "Owner edit after upgrade", status: "done" });
    expect(await taskOn(a, explicit.id)).toMatchObject({ board: "hidden", details: "Choice stays local" });
    expect(await tasksOf(a)).toHaveLength(2);
    expect(await tasksOf(b)).toHaveLength(2);
  }, 60_000);
}

for (const oldClient of [false, true]) {
  test(`automatic hiding recovers shown done tasks after actual c18ab355 upgrade (${oldClient ? "old client" : "old server"})`, async () => {
    const suffix = oldClient ? "client" : "server";
    const aName = `shown-upgrade-A-${suffix}`, bName = `shown-upgrade-B-${suffix}`;
    let a = await install(aName, {}, oldClient ? oldSource() : process.cwd());
    let b = await install(bName, {}, oldClient ? process.cwd() : oldSource());
    const via = await meter(b);
    meters.push(via);
    const peerId = await link(a, b, { projects: [key] }, via.url);
    const originals: BoardTask[] = [];
    // Both directions use the real old decoder, with explicitly shown done rows.
    for (const side of [a, b]) {
      const task = await createOn(side, `Shown done from ${side === a ? "A" : "B"}`, { board: "shown", details: "Keep details", color: "sky", icon: "check", priority: "high" });
      expect((await patchOn(side, task.id, { status: "done", color: "sky", icon: "check", priority: "high" })).status).toBe(200);
      originals.push((await taskOn(side, task.id))!);
    }
    const locallyHidden = await createOn(a, "Explicit local hide survives replay", { board: "shown" });
    const oldSide = oldClient ? a : b;
    const chosenHidden = await createOn(oldSide, "Repeat local hide of a done arrival", { board: "shown" });
    expect((await patchOn(oldSide, chosenHidden.id, { status: "done" })).status).toBe(200);
    const chosenShown = await createOn(oldSide, "Explicit local show survives replay", { board: "hidden" });
    expect((await patchOn(oldSide, chosenShown.id, { status: "done" })).status).toBe(200);
    await sync(a, peerId);
    for (const side of [a, b]) for (const task of originals) {
      expect(await taskOn(side, task.id)).toMatchObject({ text: task.text, details: task.details, status: "done", color: task.color, icon: task.icon, priority: task.priority });
    }
    // Exercise edits in both directions while the actual old decoder is still running.
    expect((await patchOn(a, originals[0]!.id, { details: "Mixed-version edit from A" })).status).toBe(200);
    expect((await patchOn(b, originals[1]!.id, { details: "Mixed-version edit from B" })).status).toBe(200);
    await sync(a, peerId);
    expect((await taskOn(b, originals[0]!.id))?.details).toBe("Mixed-version edit from A");
    expect((await taskOn(a, originals[1]!.id))?.details).toBe("Mixed-version edit from B");
    originals[0] = (await taskOn(a, originals[0]!.id))!;
    originals[1] = (await taskOn(b, originals[1]!.id))!;
    expect((await patchOn(b, locallyHidden.id, { board: "hidden" })).status).toBe(200);
    // A repeated hide is still an explicit choice, even when the value is unchanged.
    const newSide = oldClient ? b : a;
    expect((await patchOn(newSide, chosenHidden.id, { board: "hidden" })).status).toBe(200);
    expect((await patchOn(newSide, chosenShown.id, { board: "shown" })).status).toBe(200);
    const recover = originals[oldClient ? 1 : 0]!;
    if (oldClient) {
      await stopInstall(a);
      a = await install(aName);
    } else {
      await stopInstall(b);
      b = await install(bName);
      via.retarget(b);
    }
    await sync(a, peerId);
    await sync(a, peerId);
    const receiver = oldClient ? a : b;
    // Check persistence before asserting recovery, so the base repro reaches restart too.
    const recovered = await taskOn(receiver, recover.id);
    await stopInstall(receiver);
    if (oldClient) a = await install(aName);
    else { b = await install(bName); via.retarget(b); }
    await sync(a, peerId);
    expect(recovered).toMatchObject({ board: "shown" });
    expect(await taskOn(oldClient ? a : b, recover.id)).toMatchObject({ board: "shown" });
    expect((await taskOn(oldClient ? b : a, chosenHidden.id))?.board).toBe("hidden");
    expect((await taskOn(b, locallyHidden.id))?.board).toBe("hidden");
    expect((await taskOn(oldClient ? b : a, chosenShown.id))?.board).toBe("shown");
    for (const side of [a, b]) {
      expect(await tasksOf(side)).toHaveLength(5);
      for (const task of originals) {
        expect(await taskOn(side, task.id)).toMatchObject({ board: "shown", id: task.id, text: task.text, details: task.details, color: task.color, icon: task.icon, priority: task.priority,
          status: "done", placement: task.placement, machine: task.machine, createdAt: task.createdAt, updatedAt: task.updatedAt, sync: { s: task.sync!.s }, assignments: task.assignments });
      }
    }
    // Edits remain bidirectional after upgrade as well.
    expect((await patchOn(a, originals[0]!.id, { details: "Edited from A" })).status).toBe(200);
    expect((await patchOn(b, originals[1]!.id, { details: "Edited from B" })).status).toBe(200);
    await sync(a, peerId);
    expect((await taskOn(b, originals[0]!.id))?.details).toBe("Edited from A");
    expect((await taskOn(a, originals[1]!.id))?.details).toBe("Edited from B");
  }, 60_000);
}


test("automatic membership recovery respects admission and retries when a band becomes available", async () => {
  let a = await install("capacity-upgrade-A", {}, oldSource());
  const b = await install("capacity-upgrade-B");
  const peerId = await link(a, b);
  const arrived = await createOn(a, "Shown done under a full receiving board", { board: "shown", details: "Keep capacity history" });
  expect((await patchOn(a, arrived.id, { status: "done" })).status).toBe(200);
  // Fill using the public create route, so the exact production limit applies.
  const bands: BoardTask[] = [];
  for (let i = 0; i < 300; i++) bands.push(await createOn(b, `Capacity band ${i}`));
  await sync(a, peerId);
  await stopInstall(a);
  a = await install("capacity-upgrade-A");
  await sync(a, peerId);
  await sync(a, peerId);
  expect((await taskOn(b, arrived.id))?.board).toBe("hidden");
  expect((await tasksOf(b)).filter((task) => taskShowsOnBoard(task, false))).toHaveLength(300);
  expect((await patchOn(b, bands[0]!.id, { board: "hidden" })).status).toBe(200);
  expect((await patchOn(a, arrived.id, { details: "A later source edit retries admission" })).status).toBe(200);
  await sync(a, peerId);
  expect(await taskOn(b, arrived.id)).toMatchObject({ board: "shown", details: "A later source edit retries admission" });
  expect((await tasksOf(b)).filter((task) => taskShowsOnBoard(task, false))).toHaveLength(300);
  expect(await tasksOf(b)).toHaveLength(301);
}, 60_000);

test("visible board HEAD requests sustain short sync cadence after idle and expire on close", async () => {
  const a = await install("cadence-A"), b = await install("cadence-B");
  await link(a, b);
  const tick = async (offset: number, visible = false) => {
    await request(a, `/test/clock?offset=${offset}`);
    if (visible) expect((await fetch(a + boardPresenceUrl(key), { method: "HEAD" })).status).toBe(204);
    return request(a, `/test/schedule?project=${key}`);
  };
  for (let at = 0; at <= 600_000; at += 10_000) await tick(at);
  const count = async () => Number((await request(b, "/test/metrics")).body.syncCalls);
  const idle = await count();
  // Presence shortens an existing five-minute idle deadline on the next tick.
  expect((await tick(610_000, true)).body.open).toBe(true);
  expect(await count()).toBe(idle + 1);
  for (let at = 625_000; at <= 700_000; at += 15_000) await tick(at, true);
  expect(await count()).toBe(idle + 7);
  expect((await tick(745_000)).body.open).toBe(false);
  const closed = await count();
  for (let at = 755_000; at < 1_045_000; at += 10_000) await tick(at);
  expect(await count()).toBe(closed);
  // Overview displays all linked boards, with the same bodyless request path.
  expect((await fetch(a + boardPresenceUrl("__overview__"), { method: "HEAD" })).status).toBe(204);
  expect((await request(a, `/test/schedule?project=${key}`)).body.open).toBe(true);
}, 30_000);

test("both link sides show successful sync time, retain it on failure and recover honestly", async () => {
  let a = await install("status-A"), b = await install("status-B");
  const peerId = await link(a, b);
  const peer = async () => ((await request(a, "/api/links/peers")).body.peers as { lastCall: number; state: string; error: string | null }[])[0]!;
  const grant = async () => ((await request(b, "/api/links/grants")).body.grants as { lastCall: number; state: string; error: string | null }[])[0]!;
  const successA = await peer(), successB = await grant();
  expect(successA.lastCall).toBeGreaterThan(0);
  expect(successB.lastCall).toBeGreaterThan(0);
  await request(b, "/test/fail-sync?on=1");
  expect((await request(a, `/api/links/peers/${peerId}`, "POST")).status).toBe(409);
  expect(await peer()).toMatchObject({ lastCall: successA.lastCall, state: "failing", error: "not-delegatus" });
  await request(b, "/test/fail-sync?on=0");
  const stored = JSON.parse(fs.readFileSync(path.join(root, "status-A/links/peers.json"), "utf8")).peers[0] as { token: string; grantId: string };
  expect((await fetch(b + "/api/peer/v1/boards/sync", { method: "POST", body: "{}", headers: { "content-type": "application/json", "x-delegatus-peer": `${stored.grantId}.${stored.token}` } })).status).toBe(400);
  expect(await grant()).toMatchObject({ lastCall: successB.lastCall, state: "failing", error: "malformed" });
  await sync(a, peerId);
  expect(await peer()).toMatchObject({ state: "active", error: null });
  expect(await grant()).toMatchObject({ state: "active", error: null });
  await Promise.all([stopInstall(a), stopInstall(b)]);
  a = await install("status-A");
  b = await install("status-B");
  expect((await peer()).lastCall).toBeGreaterThan(0);
  expect((await grant()).lastCall).toBeGreaterThan(0);
}, 30_000);


test("historical unchosen-title sender reproduces placeholder arrivals both ways; current sender and repair preserve titles", async () => {
  const a = await install("wire-title-A"), b = await install("wire-title-B");
  const automatic = async (base: string, text: string) => {
    const ids = (await request(base, "/test/bulk", "POST", { project: key, count: 1, text, explicit: false })).body.ids as string[];
    await patchOn(base, ids[0]!, { details: "Shared details survive" });
    return (await taskOn(base, ids[0]!))!;
  };
  const fromA = await automatic(a, "Automatic owner title A"), fromB = await automatic(b, "Automatic owner title B");
  const aId = JSON.parse(fs.readFileSync(path.join(root, "wire-title-A/links/self.json"), "utf8")).installId as string;
  const bId = JSON.parse(fs.readFileSync(path.join(root, "wire-title-B/links/self.json"), "utf8")).installId as string;
  expect(fromA.chosen).toBeUndefined();
  expect(fromB.chosen).toBeUndefined();
  const peerId = await link(a, b, { projects: [key] }, b, false);
  await request(a, "/test/legacy-task-wire?on=1");
  await request(b, "/test/legacy-task-wire?on=1");
  await sync(a, peerId);
  expect(await taskOn(b, fromA.id)).toMatchObject({ text: "Untitled task", details: fromA.details, assignments: [], machine: aId });
  expect(await taskOn(a, fromB.id)).toMatchObject({ text: "Untitled task", details: fromB.details, assignments: [], machine: bId });
  const pages = await captured(b);
  const pushed = pages.flatMap((page) => JSON.parse(page.request).push?.rows ?? []).find((row) => row.id === fromA.id);
  const pulled = pages.flatMap((page) => JSON.parse(page.response).tasks?.rows ?? []).find((row) => row.id === fromB.id);
  expect([pushed.text, pulled.text]).toEqual(["Untitled task", "Untitled task"]);
  expect(pushed.s.text).toBe(derivedStamp(fromA.updatedAt, installPrefix(aId)));
  expect(pulled.s.text).toBe(derivedStamp(fromB.updatedAt, installPrefix(bId)));
  // The authoritative store kept its real title while the wire lost it.
  expect((await taskOn(a, fromA.id))!.text).toBe(fromA.text);
  expect((await taskOn(b, fromB.id))!.text).toBe(fromB.text);
  await request(a, "/test/legacy-task-wire?on=0");
  await request(b, "/test/legacy-task-wire?on=0");
  await sync(a, peerId);
  expect((await taskOn(b, fromA.id))!.text).toBe(fromA.text);
  expect((await taskOn(a, fromB.id))!.text).toBe(fromB.text);
  const before = await Promise.all([tasksOf(a), tasksOf(b)]);
  await sync(a, peerId);
  expect(await Promise.all([tasksOf(a), tasksOf(b)])).toEqual(before);
}, 30_000);
/* Synced task card (docs/design/synced-task-card.md): the owner's lanes ride in the agents part. */
type LaneSpec = { id: string; taskIds: string[]; state: string; current?: string; sentinel?: string; stages: Array<Record<string, unknown>> };
const threeStages = (running: "review" | "fix" | "done", extra: Record<string, unknown> = {}) => [
  { id: "build", role: "builder", next: "review", attempt: { state: "passed" } },
  { id: "review", role: "reviewer", next: "fix", attempt: { state: running === "review" ? "running" : "passed", ...extra } },
  { id: "fix", role: "builder", next: null, ...(running === "review" ? {} : { attempt: { state: running === "fix" ? "running" : "passed" } }) },
];
const laneOn = (base: string, spec: LaneSpec) => request(base, "/test/pipeline", "POST", { project: key, ...spec });
type ApiLane = { k: string; tk: string[]; s: string; install: string; peer: string; stale: boolean; g: { id: string; st: string; n?: number; e?: string; m?: string }[] };
const lanesOn = async (base: string) => (await request(base, `/api/links/agents?project=${key}`)).body as unknown as { agents: unknown[]; lanes: ApiLane[]; self: string | null; hosts: Record<string, { label: string; linked: boolean }> };

test("a remote task's running lane shows its stages on the other install and follows a stage change after the next sync, both ways", async () => {
  const a = await install("lanes-A");
  const b = await install("lanes-B");
  const peerId = await link(a, b);
  const onB = await createOn(b, "Ship the synced card");
  await sync(a, peerId);
  const owner = (await taskOn(a, onB.id))!.machine!;
  expect(owner).toBe((await taskOn(b, onB.id))!.machine!);
  expect((await lanesOn(a)).lanes).toEqual([]);
  expect((await laneOn(b, { id: "5e0a41c2", taskIds: [onB.id], state: "running", current: "review", stages: threeStages("review") })).status).toBe(200);
  await sync(a, peerId);
  const first = await lanesOn(a);
  expect(first.lanes).toHaveLength(1);
  expect(first.lanes[0]).toMatchObject({ k: "l:5e0a41c2", tk: [onB.id], s: "running", install: owner, stale: false });
  expect(first.lanes[0]!.g.map((stage) => [stage.id, stage.st])).toEqual([["build", "passed"], ["review", "running"], ["fix", "pending"]]);
  expect(first.lanes[0]!.g[1]).toMatchObject({ n: 1, e: "codex", m: "gpt-6.1-sol" });
  expect(first.hosts[owner]).toMatchObject({ linked: true });
  expect(first.self).toBeTruthy();
  // B's review fails and its fix runs: A shows the new states after its next call.
  await laneOn(b, { id: "5e0a41c2", taskIds: [onB.id], state: "running", current: "fix", stages: threeStages("fix", { findings: ["one"] }) });
  await sync(a, peerId);
  const moved = (await lanesOn(a)).lanes[0]!;
  expect(moved.g.map((stage) => [stage.id, stage.st])).toEqual([["build", "passed"], ["review", "passed"], ["fix", "running"]]);
  // The other direction: a lane A owns reaches B over push.agents.
  const onA = await createOn(a, "A's own task");
  await sync(a, peerId);
  await laneOn(a, { id: "a1b2c3d4", taskIds: [onA.id], state: "needs_decision", current: "review", stages: threeStages("review") });
  await sync(a, peerId);
  const seenOnB = await lanesOn(b);
  expect(seenOnB.lanes.map((lane) => lane.k)).toEqual(["l:a1b2c3d4"]);
  expect(seenOnB.lanes[0]).toMatchObject({ s: "needs_decision", install: (await taskOn(b, onA.id))!.machine });
  // A lane ended on the owner leaves the feed as a marker once its task goes.
  expect((await request(b, `/api/tasks/${onB.id}`, "DELETE")).status).toBe(200);
  await sync(a, peerId);
  expect((await lanesOn(a)).lanes).toEqual([]);
}, 60_000);

test("a peer at c18ab355 keeps syncing tasks and agents in both directions while lane rows cross", async () => {
  for (const oldClient of [true, false]) {
    const aName = `lanes-mixed-A-${oldClient}`, bName = `lanes-mixed-B-${oldClient}`;
    const a = await install(aName, {}, oldClient ? oldSource() : process.cwd());
    const b = await install(bName, {}, oldClient ? process.cwd() : oldSource());
    const peerId = await link(a, b);
    const current = oldClient ? b : a, old = oldClient ? a : b;
    const owned = await createOn(current, "Owned by the new install");
    seedTranscript(oldClient ? aName : bName, "PROMPT-CANARY-old-side-agent");
    seedTranscript(oldClient ? bName : aName, "PROMPT-CANARY-new-side-agent");
    await request(a, "/test/scan");
    await request(b, "/test/scan");
    await sync(a, peerId);
    expect((await laneOn(current, { id: "5e0a41c2", taskIds: [owned.id], state: "running", current: "review", stages: threeStages("review") })).status).toBe(200);
    await captured(b);
    await sync(a, peerId);
    await sync(a, peerId);
    const wire = (await captured(b)).flatMap((call) => [call.request, call.response]).join("\n");
    // B's bodies hold the new side's lane row: its answer to an old client, or what a new client pushed to an old server.
    expect(wire).toContain('"k":"l:5e0a41c2"');
    // Tasks and agents keep syncing both ways, whichever side is old.
    expect((await taskOn(old, owned.id))?.text).toBe(owned.text);
    expect(((await request(a, `/test/agents?project=${key}`)).body as unknown as unknown[])).toHaveLength(1);
    expect(((await request(b, `/test/agents?project=${key}`)).body as unknown as unknown[])).toHaveLength(1);
    const backTask = await createOn(old, "Created on the old side");
    await sync(a, peerId);
    expect((await taskOn(current, backTask.id))?.text).toBe(backTask.text);
    // The new side draws the old peer's agents and no lane of it, without an error.
    const answer = await lanesOn(current);
    expect(answer.agents).toHaveLength(1);
    expect(answer.lanes).toEqual([]);
  }
}, 90_000);

test("lane rows add nothing to an idle call, and one stage flip costs its row plus at most 300 bytes", async () => {
  const a = await install("lane-meter-A");
  const b = await install("lane-meter-B");
  const wire = await meter(b);
  meters.push(wire);
  const peerId = await link(a, b, { projects: [key] }, wire.url);
  const onA = await createOn(a, "A task");
  const onB = await createOn(b, "B task");
  await sync(a, peerId);
  await laneOn(a, { id: "a1b2c3d4", taskIds: [onA.id], state: "running", current: "review", stages: threeStages("review") });
  await laneOn(b, { id: "5e0a41c2", taskIds: [onB.id], state: "running", current: "review", stages: threeStages("review") });
  await sync(a, peerId);
  await sync(a, peerId);
  expect((await lanesOn(a)).lanes).toHaveLength(1);
  expect((await lanesOn(b)).lanes).toHaveLength(1);
  await captured(b);
  const idleUp = wire.up, idleDown = wire.down;
  await sync(a, peerId);
  const idleBytes = wire.up - idleUp + wire.down - idleDown;
  const idle = (await captured(b))[0]!;
  expect(Buffer.byteLength(idle.request)).toBeLessThanOrEqual(200);
  expect(Buffer.byteLength(idle.response)).toBeLessThanOrEqual(200);
  expect(idleBytes).toBeLessThanOrEqual(WIRE_BUDGET);
  await laneOn(b, { id: "5e0a41c2", taskIds: [onB.id], state: "running", current: "fix", stages: threeStages("fix") });
  const flipUp = wire.up, flipDown = wire.down;
  await sync(a, peerId);
  const flipBytes = wire.up - flipUp + wire.down - flipDown;
  const calls = await captured(b);
  const rows = calls.flatMap((call) => (JSON.parse(call.response) as { agents?: { rows?: { k: string }[] } }).agents?.rows ?? []);
  expect(rows.map((row) => row.k)).toEqual(["l:5e0a41c2"]);
  const rowBytes = Buffer.byteLength(JSON.stringify(rows[0]));
  expect(rowBytes).toBeLessThan(700);
  expect(flipBytes - idleBytes).toBeLessThanOrEqual(rowBytes + 300);
  expect((await lanesOn(a)).lanes[0]!.g.find((stage) => stage.id === "fix")!.st).toBe("running");
}, 60_000);

test("no prompt, spec, finding, summary, path or conversation id of a lane crosses, and a lane exchange writes no disk state", async () => {
  const a = await install("lane-private-A");
  const b = await install("lane-private-B");
  const peerId = await link(a, b);
  const onA = await createOn(a, "A task");
  const onB = await createOn(b, "B task");
  await sync(a, peerId);
  const canary = "LANE-SECRET-SENTINEL";
  await laneOn(a, { id: "a1b2c3d4", taskIds: [onA.id], state: "needs_decision", current: "review", sentinel: canary, stages: threeStages("review", { findings: ["finding text"] }) });
  await laneOn(b, { id: "5e0a41c2", taskIds: [onB.id], state: "needs_decision", current: "review", sentinel: canary, stages: threeStages("review", { findings: ["finding text"] }) });
  const diskA = fileMarks("lane-private-A");
  const diskB = fileMarks("lane-private-B");
  await captured(a);
  await captured(b);
  await sync(a, peerId);
  await sync(a, peerId);
  expect((await lanesOn(a)).lanes).toHaveLength(1);
  expect((await lanesOn(b)).lanes).toHaveLength(1);
  const bodies = [...await captured(a), ...await captured(b)].flatMap((call) => [call.request, call.response]).join("\n");
  expect(bodies).toContain('"k":"l:');
  expect(bodies).not.toContain(canary);
  expect(bodies).not.toContain("transcript.jsonl");
  expect(JSON.stringify([(await lanesOn(a)).lanes, (await lanesOn(b)).lanes])).not.toContain(canary);
  expect(fileMarks("lane-private-A")).toEqual(diskA);
  expect(fileMarks("lane-private-B")).toEqual(diskB);
}, 60_000);

test("120 lanes reset over the real link in pages of at most 50 entries and 80 KB, and both machines agree", async () => {
  const a = await install("lane-pages-A");
  const b = await install("lane-pages-B");
  const peerId = await link(a, b);
  const { ids } = (await request(b, "/test/bulk", "POST", { project: key, count: 40, explicit: true })).body as unknown as { ids: string[] };
  await sync(a, peerId);
  const many = Array.from({ length: 120 }, (_v, n) => ({ project: key, id: n.toString(16).padStart(8, "0"), taskIds: [ids[n % 40]!], state: "running", current: "review", stages: threeStages("review") }));
  expect((await request(b, "/test/pipeline", "POST", { many })).status).toBe(200);
  await request(a, `/test/agent-reset?id=${peerId}`);
  await captured(b);
  await sync(a, peerId);
  for (let round = 0; round < 6 && (await lanesOn(a)).lanes.length < 120; round++) await sync(a, peerId);
  const lanes = (await lanesOn(a)).lanes;
  expect(lanes).toHaveLength(120);
  const perTask = new Map<string, number>();
  for (const lane of lanes) perTask.set(lane.tk[0]!, (perTask.get(lane.tk[0]!) ?? 0) + 1);
  expect(Math.max(...perTask.values())).toBe(3);
  const pages = (await captured(b)).map((call) => (JSON.parse(call.response) as { agents?: { rows?: unknown[] } }).agents?.rows ?? []).filter((rows) => rows.length);
  expect(pages.length).toBeGreaterThanOrEqual(3);
  for (const rows of pages) {
    expect(rows.length).toBeLessThanOrEqual(50);
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(80_000);
  }
}, 90_000);
