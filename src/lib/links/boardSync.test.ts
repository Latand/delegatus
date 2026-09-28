/**
 * Two isolated installs, each its own process on port 0, syncing tasks over
 * the real peer routes (docs/design/linked-installs.md M.11 slice M2). A
 * makes every call; B is never given A's address. Wire figures come from a
 * TCP counting proxy between the two (`wireMeter.ts`); body figures are
 * `Buffer.byteLength` of what the test server received and answered.
 */
import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectIdentityFromRemote } from "@/lib/projects/identity";
import type { BoardTask } from "@/lib/tasks/types";
import { meter, WIRE_BUDGET, type Meter } from "./wireMeter";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-board-sync-test-"));
const remote = "code.example.test/acme/widget";
const key = projectIdentityFromRemote(`https://${remote}`, "/")!.project;
const processes: ChildProcessWithoutNullStreams[] = [];
const meters: Meter[] = [];
afterAll(() => {
  for (const counts of meters) counts.close();
  for (const child of processes) if (child.pid && !child.killed) child.kill("SIGTERM");
  fs.rmSync(root, { recursive: true, force: true });
});

async function install(name: string, extraRemotes: Record<string, string> = {}): Promise<string> {
  const state = path.join(root, name);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { [key]: remote, ...extraRemotes } }));
  // Each install scans only its own homes, never the operator's transcripts.
  const home = path.join(state, "home");
  const child = spawn(process.execPath, ["src/lib/links/testServer.ts", state], { cwd: process.cwd(), env: { ...process.env, LLV_STATE_DIR: state, XDG_CONFIG_HOME: path.join(state, "config"),
    HOME: home, LLV_CLAUDE_HOME: path.join(home, ".claude"), LLV_CODEX_HOME: path.join(home, ".codex") } });
  processes.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split("\n")[0];
      if (line && output.includes("\n")) {
        try { resolve((JSON.parse(line) as { port: number }).port); } catch (error) { reject(error); }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    child.on("exit", (code) => reject(new Error(`test server exited ${code}: ${errors}`)));
    setTimeout(() => reject(new Error(`test server did not start: ${errors}`)), 15_000).unref();
  });
  return `http://127.0.0.1:${port}`;
}

async function request(base: string, route: string, method = "GET", body?: object) {
  const response = await fetch(base + route, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** Pairs A to B (through `via`, a proxy in front of B, when given) and links the given projects on both sides. */
async function link(a: string, b: string, share: { all?: boolean; projects?: string[] } = { projects: [key] }, via = b): Promise<string> {
  const code = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: via, code })).status).toBe(200);
  const peerId = ((await request(a, "/api/links/peers")).body.peers as { id: string }[])[0]!.id;
  for (const side of [a, b]) expect((await request(side, "/api/links/shared", "POST", { v: 1, all: share.all ?? false, projects: share.projects ?? [] })).status).toBe(200);
  await sync(a, peerId);
  return peerId;
}

async function sync(a: string, peerId: string): Promise<void> {
  const answer = await request(a, `/api/links/peers/${peerId}`, "POST");
  if (answer.status !== 200) throw new Error(`sync failed: ${JSON.stringify(answer.body)}`);
}

const tasksOf = async (base: string) => (await request(base, "/test/tasks")).body as unknown as BoardTask[];
const taskOn = async (base: string, id: string) => (await tasksOf(base)).find((task) => task.id === id);
async function createOn(base: string, text: string, extra: Record<string, unknown> = {}): Promise<BoardTask> {
  const created = await request(base, "/api/tasks", "POST", { project: key, text, placement: "unplaced", ...extra });
  expect(created.status).toBe(200);
  return created.body.task as BoardTask;
}
async function patchOn(base: string, id: string, patch: Record<string, unknown>) {
  const answer = await request(base, `/api/tasks/${id}`, "PATCH", patch);
  return answer;
}
type Captured = { request: string; response: string };
const captured = async (base: string, reset = true) => (await request(base, `/test/captured${reset ? "?reset=1" : ""}`)).body as unknown as Captured[];

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

/** A Claude transcript on A whose first prompt carries a canary, in a checkout of the linked repository. */
function seedTranscript(name: string, prompt: string): void {
  const checkout = path.join(root, name, "checkout", "widget");
  fs.mkdirSync(checkout, { recursive: true });
  for (const args of [["init", "-q"], ["remote", "add", "origin", `https://${remote}`]]) {
    const git = Bun.spawnSync(["git", ...args], { cwd: checkout, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    if (git.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${git.stderr.toString()}`);
  }
  const projects = path.join(root, name, "home", ".claude", "projects", checkout.replace(/[/.]/g, "-"));
  fs.mkdirSync(projects, { recursive: true });
  const at = (offset: number) => new Date(Date.now() - 60_000 + offset).toISOString();
  const envelope = { isSidechain: false, userType: "external", entrypoint: "sdk-cli", cwd: checkout, sessionId: "session-canary", version: "2.1.0", gitBranch: "main" };
  const records = [
    { ...envelope, parentUuid: null, uuid: "rec-prompt", timestamp: at(0), type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } },
    { ...envelope, parentUuid: "rec-prompt", uuid: "rec-answer", timestamp: at(1_000), type: "assistant", requestId: "req-1",
      message: { id: "msg-1", model: "claude-opus-5", role: "assistant", type: "message", stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: "Done." }] } },
  ];
  fs.writeFileSync(path.join(projects, "session-canary.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

test("tasks created, changed in every group and deleted on either machine show on the other after one call; prompts never cross; an idle link costs next to nothing", async () => {
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
  // Every body from the first exchange until the tasks are named is kept and scanned.
  const bodies: string[] = [];
  const drain = async () => { for (const call of await captured(b)) bodies.push(call.request, call.response); };
  const peerId = await link(a, b, { projects: [key] }, wire.url);
  await sync(a, peerId);
  expect((await taskOn(b, canaryA[0]!))?.text).toBe("Untitled task");
  expect((await taskOn(a, canaryB[0]!))?.text).toBe("Untitled task");
  for (const task of prompted) expect((await taskOn(b, task.id))?.text).toBe("Untitled task");
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

  // No request or answer body so far carried a prompt, the first exchange included.
  await drain();
  expect(bodies.length).toBeGreaterThan(20);
  expect(bodies.join("\n")).not.toContain("CANARY");

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
  expect(refusedOnA.error).toContain("(not linked)");
}, 60_000);
