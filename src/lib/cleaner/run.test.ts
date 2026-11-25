import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { checkEnvironment } from "../../../scripts/gate-cache";
import { isolatedEnvironment } from "../../../scripts/local-gate";
import { readBridgeReportLog } from "@/lib/bridge/store";
import { publishHotStateAuthority } from "@/lib/state/hotStateAuthority";
import { loadPrototypeTask, loadTasksForList } from "@/lib/tasks/store";
import { cleanerCompletionIsOnTime, createCleanerController } from "./run";
import { activeCleanerRun, claimCleanerRun, cleanerAttemptMayStart, pendingCleanerCard, readCleanerRun, recordCleanerCardAttempt, scheduledCleanerRunProvenance, updateActiveCleanerRun, type CleanerLaunchBody, type CleanerRun } from "./store";

const start = Date.parse("2031-02-01T11:00:00.000Z");
const minute = 60_000;
const day = 1440 * minute;
const at = (offset: number) => new Date(start + offset).toISOString();
const project = "repo-1234abcd";
const roots: string[] = [];
const initialState = process.env.LLV_STATE_DIR;
afterEach(() => {
  if (initialState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = initialState;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cleaner-"));
  roots.push(root);
  const env = isolatedEnvironment(root, checkEnvironment(process.env));
  const state = env.LLV_STATE_DIR!;
  process.env.LLV_STATE_DIR = state;
  env.LLV_STATE_OWNER = "viewer";
  delete env.LLV_CLEANER;
  delete env.PORT;
  function target(offset: number, own = true) {
    env.PORT = "9230";
    const file = path.join(state, "viewer-release.json");
    const revision = "a".repeat(40);
    fs.writeFileSync(file, JSON.stringify({
      endpoint: `http://127.0.0.1:${own ? env.PORT : 9231}`, revision, hotStateBackend: "sqlite-v1",
    }));
    fs.utimesSync(file, new Date(start + offset), new Date(start + offset));
    if (own) publishHotStateAuthority(state, "sqlite", revision, { activationReadyAt: at(offset) });
  }
  function drain(until: number) {
    fs.mkdirSync(path.join(state, "self-update"), { recursive: true });
    fs.writeFileSync(path.join(state, "self-update", "auto-drain.json"),
      JSON.stringify({ id: "fixture-drain", target: "fixture-release", since: at(0), until: start + until }));
  }
  function history() {
    const file = path.join(state, "state.sqlite");
    if (!fs.existsSync(file)) return [];
    using db = new Database(file, { readonly: true });
    return db.query<{ value_json: string }, []>("SELECT value_json FROM state_rows WHERE collection='cleaner-runs' AND row_key LIKE 'run:%'")
      .all().map(row => JSON.parse(row.value_json) as CleanerRun);
  }
  async function tick(offset: number, space: "ok" | "low" | "ready", fault = "none", exit = 0) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "run.fixture.ts"), fault, at(offset), space],
      { env, stdout: "pipe", stderr: "pipe" });
    const [out, errors, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status, errors).toBe(exit);
    if (exit !== 0) return null;
    expect(errors).not.toContain("observation failed");
    expect(errors).not.toContain("launch reply unavailable");
    return JSON.parse(out) as { active: CleanerRun | null; pending: CleanerRun | null; ledger: Record<string, { body: object; calls: number }> };
  }
  function startTick(offset: number, space: "ok" | "low" | "ready", fault = "none") {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "run.fixture.ts"), fault, at(offset), space],
      { env, stdout: "pipe", stderr: "pipe" });
    return { child, output: new Response(child.stdout).text(), errors: new Response(child.stderr).text() };
  }
  return { state, env, target, drain, history, tick, startTick, card: (id: string) => loadPrototypeTask(id, path.join(state, "tasks.json")) };
}

test("the ordinary watch preserves alarm effects with no launcher or cleaner receipt", async () => {
  const { tick, state, target, history } = fixture();
  target(0);
  await tick(0, "ready", "observe-only");
  await tick(16 * minute, "ready", "observe-only");
  expect(history()).toEqual([]);
  const notice = JSON.parse(fs.readFileSync(path.join(state, "disk-pressure-actions.json"), "utf8"));
  expect(notice).toMatchObject({ card: true, report: true });
  expect(notice).not.toHaveProperty("cleaner");
  expect(loadTasksForList(path.join(state, "tasks.json"))).toHaveLength(1);
  expect(readBridgeReportLog().reports).toHaveLength(1);
  expect(fs.existsSync(path.join(state, "fixture-sweeps"))).toBeFalse();
});

test("pressure waits for the wake, joins overlapping processes, links the card and retries after a live run", async () => {
  const { tick, history, state, card } = fixture();
  await tick(0, "low");
  await tick(15 * minute - 1, "low");
  expect(history()).toHaveLength(0);
  await Promise.all([tick(15 * minute, "low"), tick(15 * minute, "low")]);
  const [first] = history();
  expect(first!.trigger).toBe(`disk-pressure:${at(0)}`);
  expect(first!.mode).toBe("dry-run");
  expect(first!.launchBody).toMatchObject({
    project, role: "cleaner", roleParams: { mode: "disk" }, taskId: first!.taskId,
    clientAttemptId: first!.runId, mcpServers: ["viewer"], notifyLauncher: false,
  });
  const linked = (await tick(16 * minute, "ready"))!;
  expect(Object.keys(linked.ledger)).toEqual([first!.runId]);
  expect(loadTasksForList(path.join(state, "tasks.json")).some(task => task.text.includes(first!.taskId))).toBe(true);
  expect(readBridgeReportLog().reports).toHaveLength(1);
  await tick(17 * minute, "ok");
  await tick(18 * minute, "ready");
  expect(history()).toHaveLength(1);
  await tick(19 * minute, "ready", "success");
  expect(card(first!.taskId)?.status).toBe("done");
  const second = (await tick(20 * minute, "ready"))!.active!;
  expect(second.trigger).toBe(`disk-pressure:${at(18 * minute)}`);
  expect(second.launchBody?.prompt).toContain("Previous run");
  expect(second.launchBody?.prompt).toContain("temp · 9.00 GiB");
  expect(history()).toHaveLength(2);
  expect(readBridgeReportLog().reports).toHaveLength(2);
});

test("daily eligibility follows managed traffic time and the last daily claim across restarts", async () => {
  const { tick, target, drain, history } = fixture();
  target(0);
  await tick(10 * minute - 1, "ok");
  expect(history()).toHaveLength(0);
  drain(10 * minute + 10);
  await tick(10 * minute, "ok");
  expect(history()).toHaveLength(0);
  const first = (await tick(10 * minute + 10, "ok", "prepare-crash", 71));
  expect(first).toBeNull();
  const [claimed] = history();
  expect(claimed?.trigger).toBe("daily:2031-02-01");
  expect(claimed?.claimedAt).toBe(at(10 * minute + 10));
  await tick(26 * minute, "ok");
  await tick(27 * minute, "ok", "success");
  // A pressure claim has its own clock.
  await tick(day - minute, "ready");
  await tick(day, "ready", "success");
  target(day + 10 * minute);
  await tick(day + 10 * minute + 9, "ok");
  expect(history()).toHaveLength(2);
  const next = (await tick(day + 10 * minute + 10, "ok"))!.active;
  expect(next?.trigger).toBe("daily:2031-02-02");
  expect(next?.claimedAt).toBe(at(day + 10 * minute + 10));
});

test("daily eligibility restarts at the restored traffic owner’s promotion time", async () => {
  const { tick, target, history } = fixture();
  target(0);
  await tick(20 * minute, "ok", "switch-owner-on-read");
  expect(history()).toEqual([]);
  await tick(30 * minute - 1, "ok");
  expect(history()).toEqual([]);
  const eligible = (await tick(30 * minute, "ok"))!;
  expect(eligible.active?.trigger).toBe("daily:2031-02-01");
  expect(eligible.active?.claimedAt).toBe(at(30 * minute));
});

test("a saved launch with no registry reservation releases the slot at its deadline", async () => {
  const { tick, target, history, card } = fixture();
  target(0);
  await tick(15 * minute, "ready", "prepare-crash", 71);
  const saved = history()[0]!;
  expect(saved.launchBody?.clientAttemptId).toBe(saved.runId);
  expect(saved.settledAt).toBeNull();
  const deadlineTick = (await tick(105 * minute, "ok"))!;
  expect(readCleanerRun(saved.runId)).toMatchObject({ settledAt: at(105 * minute), quiescedAt: at(105 * minute), failure: { kind: "timed-out" } });
  expect(cleanerAttemptMayStart(saved.runId, start + 105 * minute)).toBe(false);
  expect(card(saved.taskId)?.status).toBe("blocked");
  const next = deadlineTick.active!;
  expect(next.runId).not.toBe(saved.runId);
  expect(next.trigger).toBe("daily:2031-02-01");
});

test("terminal proof arriving after timeout preserves the committed refusal and card", async () => {
  const { tick, startTick, state, history, card } = fixture();
  const started = (await tick(0, "ready"))!.active!;
  const pending = startTick(90 * minute - 1, "ready", "hold-success-observe");
  const marker = path.join(state, "fixture-observer-held");
  const until = Date.now() + 10_000;
  while (!fs.existsSync(marker) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  expect(fs.existsSync(marker)).toBe(true);
  await tick(90 * minute, "ready");
  fs.writeFileSync(path.join(state, "fixture-clock.json"), JSON.stringify({ at: at(90 * minute + 1) }));
  fs.writeFileSync(path.join(state, "fixture-observer-release"), "release");
  const [output, errors, status] = await Promise.all([pending.output, pending.errors, pending.child.exited]);
  expect(status, errors).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ active: null });
  expect(errors).not.toContain("observation failed");
  expect(history()).toContainEqual(expect.objectContaining({ runId: started.runId, settledAt: at(90 * minute),
    quiescedAt: at(90 * minute + 1), failure: { kind: "timed-out", detail: expect.any(String) } }));
  expect(card(started.taskId)?.status).toBe("blocked");
});

test("a failed launch receipt reports failure while retained host custody holds the slot", async () => {
  const { tick, history, card } = fixture();
  const running = (await tick(15 * minute, "ready"))!.active!;
  await tick(16 * minute, "ready", "failed-live");
  expect(readCleanerRun(running.runId)).toMatchObject({
    settledAt: at(16 * minute), quiescedAt: null, failure: { kind: "launch-failed" },
  });
  expect(card(running.taskId)?.status).toBe("blocked");
  expect((await tick(day, "ok"))!.active?.runId).toBe(running.runId);
  expect(history()).toHaveLength(1);
});

test("a passing report completed after the deadline settles as timed out", async () => {
  const { tick, history, card } = fixture();
  const started = (await tick(15 * minute, "ready"))!.active!;
  await tick(105 * minute + 1, "ready", "success");
  expect(readCleanerRun(started.runId)).toMatchObject({
    settledAt: at(105 * minute + 1), failure: { kind: "timed-out" }, report: null,
  });
  expect(card(started.taskId)?.status).toBe("blocked");
  expect(history()).toHaveLength(1);
});

test("an on-time completion first observed after the deadline can settle successfully", async () => {
  const { tick, history, card } = fixture();
  const started = (await tick(15 * minute, "ready"))!.active!;
  await tick(105 * minute + 1, "ready", "success-observed-late");
  expect(readCleanerRun(started.runId)).toMatchObject({
    settledAt: at(105 * minute + 1), failure: null, report: { verdict: "pass" },
  });
  expect(card(started.taskId)?.status).toBe("done");
  expect(history()).toHaveLength(1);
});

test("terminal evidence completed at the deadline remains eligible when observed later", () => {
  const launchedAt = at(15 * minute);
  expect(cleanerCompletionIsOnTime(launchedAt, at(105 * minute))).toBe(true);
  expect(cleanerCompletionIsOnTime(launchedAt, at(105 * minute + 1))).toBe(false);
  expect(cleanerCompletionIsOnTime(launchedAt, null)).toBe(false);
});

test("pressure claim and dispatch are held outside ownership and during a drain", async () => {
  const { tick, target, drain, history, env } = fixture();
  target(0, false);
  await tick(11 * minute, "ready");
  expect(history()).toEqual([]);
  target(11 * minute);
  drain(12 * minute);
  await tick(11 * minute + 1, "ready");
  expect(history()).toEqual([]);
  env.LLV_CLEANER = "off";
  await tick(12 * minute, "ready");
  expect(history()).toEqual([]);
  env.LLV_CLEANER = "dry-run";
  const live = (await tick(12 * minute + 1, "ready"))!.active!;
  await tick(13 * minute, "ready", "demote-on-observe");
  expect(history()[0]).toMatchObject({ runId: live.runId, settledAt: null });
  target(14 * minute);
  await tick(14 * minute, "ready", "success");
  expect(history()[0]).toMatchObject({ runId: live.runId, settledAt: at(14 * minute) });
});

test("a drain starting at dispatch holds the saved request until the drain expires", async () => {
  const { tick } = fixture();
  const held = (await tick(0, "ready", "drain-on-dispatch"))!;
  expect(held.active?.launchBody?.clientAttemptId).toBe(held.active?.runId);
  expect(held.ledger).toEqual({});
  expect((await tick(minute - 1, "ready"))!.ledger).toEqual({});
  const replay = (await tick(minute, "ready"))!;
  expect(replay.ledger).toEqual({ [held.active!.runId]: { body: held.active!.launchBody!, calls: 1 } });
});

test("claims, tasks, the launch request and the card result survive process exit at each checkpoint", async () => {
  const { tick, state, history, card } = fixture();
  await tick(0, "ready", "claim-crash", 71);
  const [claim] = history();
  const notice = () => JSON.parse(fs.readFileSync(path.join(state, "disk-pressure-actions.json"), "utf8"));
  expect(notice().cleaner).toBeUndefined();
  expect(claim).toMatchObject({ launchBody: null, launchedAt: null });
  await tick(1, "ready", "card-crash", 71);
  expect(notice().cleaner).toBe(true);
  expect(card(claim!.taskId)?.status).toBe("inbox");
  expect(history()[0]!.launchBody).toBeNull();
  await tick(2, "ready", "prepare-crash", 71);
  const saved = history()[0]!;
  expect(saved.launchBody?.clientAttemptId).toBe(claim!.runId);
  expect(fs.existsSync(path.join(state, "fixture-launches.json"))).toBe(false);
  await tick(16 * minute, "ready", "dispatch-crash", 71);
  expect(history()[0]!.launchAcknowledged).toBe(false);
  const replay = (await tick(17 * minute, "ready"))!;
  expect(replay.ledger).toEqual({ [claim!.runId]: { body: saved.launchBody!, calls: 2 } });
  expect(replay.active?.launchAcknowledged).toBe(true);
  await tick(18 * minute, "ready", "settlement-crash", 71);
  expect(card(claim!.taskId)?.status).toBe("inbox");
  expect(history()).toHaveLength(1);
  expect(history()[0]).toMatchObject({ settledAt: at(18 * minute), failure: null, removalJournal: [],
    report: { verdict: "pass", kept: [{ target: "fixture", reason: "keep" }] } });
  expect(history()[0]?.report).not.toHaveProperty("removed");
  await tick(19 * minute, "ready", "card-receipt-crash", 71);
  expect(card(claim!.taskId)?.status).toBe("done");
  const recovered = (await tick(20 * minute, "ready"))!;
  expect(recovered).toMatchObject({ active: null, pending: null, ledger: replay.ledger });
  expect(loadTasksForList(path.join(state, "tasks.json"))).toHaveLength(2);
});

test("expiry after claim crash restores the timed-out card and its reason", async () => {
  const { tick, history, card, state } = fixture();
  await tick(0, "ready", "claim-crash", 71);
  const claimed = history()[0]!;
  expect(card(claimed.taskId)).toBeNull();
  const restarted = (await tick(90 * minute, "ready"))!;
  const task = card(claimed.taskId);
  expect(restarted.pending).toBeNull();
  expect(task).toMatchObject({ id: claimed.taskId, status: "blocked" });
  expect(task?.details).toContain("timed-out");
  expect(task?.details).toContain("90-minute deadline");
  expect(loadTasksForList(path.join(state, "tasks.json")).filter(row => row.id === claimed.taskId)).toHaveLength(1);
});

test("pressure alarm links the recovered timed-out card without dispatching", async () => {
  const { tick, history, card, state } = fixture();
  await tick(0, "ready", "claim-crash", 71);
  const claimed = history()[0]!;
  const recovered = (await tick(90 * minute, "ready"))!;
  const notice = JSON.parse(fs.readFileSync(path.join(state, "disk-pressure-actions.json"), "utf8"));
  expect(card(claimed.taskId)).toMatchObject({ id: claimed.taskId, status: "blocked" });
  expect(notice).toMatchObject({ cleanerTaskId: claimed.taskId, cleaner: true, card: true, report: true });
  expect(notice.card).toBe(true);
  expect(recovered.ledger).toEqual({});
  expect(history()).toHaveLength(1);
});

test("timeout settles the card but fences a new turn until the old host is observed quiescent", async () => {
  const { tick, history, card, target } = fixture();
  target(0);
  const started = (await tick(0, "ready"))!.active!;
  expect(started.launchAcknowledged).toBe(true);
  const live = (await tick(90 * minute - 1, "ready"))!.active!;
  expect(live.launchedAt).toBe(started.launchedAt);
  expect(live.runId).toBe(started.runId);
  const ended = (await tick(90 * minute, "ready"))!;
  expect(ended.active).toMatchObject({ runId: started.runId, settledAt: at(90 * minute), quiescedAt: null });
  expect(history()[0]).toMatchObject({ settledAt: at(90 * minute), failure: { kind: "timed-out" }, quiescedAt: null });
  expect(card(started.taskId)?.status).toBe("blocked");
  expect(ended.ledger[started.runId]?.calls).toBe(1);
  const fenced = (await tick(day, "ok"))!;
  expect(fenced.active?.runId).toBe(started.runId);
  expect(history()).toHaveLength(1);
  target(day);
  const recovered = (await tick(day, "ok", "quiesce-after-timeout"))!;
  expect(recovered.active).toBeNull();
  expect(readCleanerRun(started.runId)?.quiescedAt).toBe(at(day));
  expect(history()).toHaveLength(1);
});

test("definitive launch refusal and host death settle with their own reason", async () => {
  const { tick, history, card } = fixture();
  await tick(0, "ready", "refused");
  const [refused] = history();
  expect(refused?.failure).toEqual({ kind: "launch-refused", detail: "No account permitted." });
  expect(card(refused!.taskId)?.status).toBe("blocked");
  await tick(1, "ok");
  const running = (await tick(2, "ready"))!.active!;
  await tick(3, "ready", "host-died");
  expect(readCleanerRun(running.runId)?.failure?.kind).toBe("host-died");
  expect(card(running.taskId)?.status).toBe("blocked");
});

test("pruning keeps the active run and unacknowledged card, with durable clocks and pressure receipt", async () => {
  const { history } = fixture();
  const allowed = () => true;
  let current = start;
  const input = { cwd: process.cwd(), project, now: () => current, allowed, evidence: { categories: [], volumes: [] } };
  const first = await claimCleanerRun({ ...input, episode: at(0) });
  if (typeof first === "string") throw new Error(first);
  const settle = (id: string) => updateActiveCleanerRun(id, allowed, run => ({ ...run,
    settledAt: at(current - start), quiescedAt: at(current - start) }));
  await settle(first.runId);
  let oldestFinished: string | null = null;
  for (let index = 0; index < 62; index++) {
    current = start + (index + 1) * day;
    const run = await claimCleanerRun({ ...input, trafficSince: start });
    if (typeof run === "string") throw new Error(run);
    oldestFinished ??= run.runId;
    if (index === 61) break;
    await settle(run.runId);
    if (index === 0) {
      await recordCleanerCardAttempt(first.runId, allowed, false);
      expect(pendingCleanerCard()?.runId).toBe(run.runId);
    }
    await recordCleanerCardAttempt(run.runId, allowed, true);
  }
  expect(history()).toHaveLength(60);
  expect(activeCleanerRun()?.claimedAt).toBe(new Date(current).toISOString());
  expect(pendingCleanerCard()?.runId).toBe(first.runId);
  expect(readCleanerRun(oldestFinished!)).toBeNull();
  const controller = createCleanerController({ now: () => current, ownsTraffic: allowed, draining: () => false,
    enabled: allowed, launch: async () => { throw new Error("a held claim must not launch"); } });
  await controller.launchCleanerIfDue(async () => project, start, null);
  const active = activeCleanerRun()!;
  await settle(active.runId);
  await recordCleanerCardAttempt(active.runId, allowed, true);
  await recordCleanerCardAttempt(first.runId, allowed, true);
  expect(await claimCleanerRun({ ...input, trafficSince: start })).toBe("held");
  current += day;
  expect(typeof await claimCleanerRun({ ...input, trafficSince: start })).toBe("object");
  expect(readCleanerRun(first.runId)).toBeNull();
  expect(await claimCleanerRun({ ...input, episode: at(0) })).toBe("already-claimed");
  expect(history()).toHaveLength(60);
});

test("scheduled Cleaner provenance requires the exact active persisted launch shape", async () => {
  const { state } = fixture();
  const run = await claimCleanerRun({ project, cwd: state, now: () => start,
    episode: "scheduled-provenance", evidence: { volumes: [], categories: [] }, allowed: () => true });
  if (typeof run === "string") throw new Error(`failed to claim scheduled provenance fixture: ${run}`);
  const body: CleanerLaunchBody = { role: "cleaner", roleParams: { mode: "disk" }, cwd: state, project,
    taskId: run.taskId, clientAttemptId: run.runId, prompt: "Persisted Cleaner prompt.",
    mcpServers: ["viewer"], notifyLauncher: false };
  await updateActiveCleanerRun(run.runId, () => true, current => ({ ...current,
    launchedAt: at(0), launchBody: body }));
  expect(scheduledCleanerRunProvenance(run.runId, body)).toBe(run.runId);
  expect(scheduledCleanerRunProvenance(run.runId, { ...body, taskId: undefined })).toBeNull();
  expect(scheduledCleanerRunProvenance(run.runId, { ...body, prompt: "Changed request" })).toBeNull();
  expect(scheduledCleanerRunProvenance(run.runId, { ...body, project: "repo-other" })).toBeNull();
});

test("a failed Cleaner receipt holds its slot until retained process custody is retired", async () => {
  const { tick, history, card, state } = fixture();
  const running = (await tick(15 * minute, "ready"))!.active!;
  await tick(16 * minute, "ready", "failed-live");
  expect(readCleanerRun(running.runId)).toMatchObject({
    settledAt: at(16 * minute), quiescedAt: null, failure: { kind: "launch-failed" },
  });
  expect(card(running.taskId)?.status).toBe("blocked");
  expect((await tick(day, "ok"))!.active?.runId).toBe(running.runId);
  expect(history()).toHaveLength(1);
  fs.writeFileSync(path.join(state, "fixture-retired"), "retired");
  await tick(day + minute, "ok", "failed-live");
  expect(readCleanerRun(running.runId)?.quiescedAt).toBe(at(day + minute));
  expect((await tick(day + 2 * minute, "ok"))!.active?.runId).not.toBe(running.runId);
});
