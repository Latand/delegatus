import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { drainFile, writeDrain } from "@/lib/selfUpdate/drain";
import { observeDiskPressureReport } from "@/lib/state/diskPressure";
import { publishHotStateAuthority } from "@/lib/state/hotStateAuthority";
import { productionDiskPressureActions } from "@/lib/state/diskPressureActions";
import { startDiskPressureWatch, stopDiskPressureWatch } from "@/lib/state/diskPressureWatch";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { loadPrototypeTask } from "@/lib/tasks/store";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { createCleanerController } from "./run";
import { activeCleanerRun, pendingCleanerCard, readCleanerRun } from "./store";

const [fault, at, space] = process.argv.slice(2);
const clock = statePath("fixture-clock.json");
const now = () => {
  try { return Date.parse(JSON.parse(fs.readFileSync(clock, "utf8")).at); }
  catch { return Date.parse(at!); }
};
const ledger = statePath("fixture-launches.json");
const end = () => process.exit(71);
type Attempt = { body: Record<string, unknown>; calls: number };
function receipts(): Record<string, Attempt> {
  try { return JSON.parse(fs.readFileSync(ledger, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
}
const controller = createCleanerController({
  now,
  ownsTraffic: () => {
    if (!viewerReleaseOwnsTraffic()) return false;
    if (fault === "card-crash") {
      const run = activeCleanerRun();
      if (run && !run.launchBody && loadPrototypeTask(run.taskId)) end();
    }
    if (fault === "settlement-crash" || fault === "card-receipt-crash") {
      const run = pendingCleanerCard();
      if (run && (fault === "settlement-crash" || loadPrototypeTask(run.taskId)?.status === "done")) end();
    }
    return true;
  },
  launch: async (body, authorize, options) => {
    if (!options?.structured) throw new Error("expected structured launch");
    const id = String(body.clientAttemptId);
    const saved = readCleanerRun(id);
    if (!saved?.launchedAt || JSON.stringify(saved.launchBody) !== JSON.stringify(body)) throw new Error("launch was not durable");
    authorize?.();
    if (fault === "prepare-crash") end();
    if (fault === "drain-on-dispatch") {
      writeDrain(drainFile(), { id: "fixture-mid-launch", target: "fixture-release", since: at!, until: now() + 60_000 });
      await Promise.resolve();
      authorize?.();
    }
    if (fault === "retryable") return { status: 503, body: { code: "spawn_preparing", retryable: true } };
    if (fault === "refused") return { status: 409, body: { code: "project_account_refused", error: "No account permitted." } };
    if (fault === "failed-live") return { status: 409, body: { code: "spawn_failed", state: "failed", error: "Host cleanup pending." } };
    return withFileTransactionAsync(ledger, "fake launch", async () => {
      authorize?.();
      const rows = receipts();
      const prior = rows[id];
      if (prior && JSON.stringify(prior.body) !== JSON.stringify(body)) throw new Error("replay changed the request");
      rows[id] = { body, calls: (prior?.calls ?? 0) + 1 };
      writeJsonDurably(ledger, rows);
      if (fault === "dispatch-crash") end();
      return { status: 200, body: { state: "settled", launched: true, conversationId: `conversation_${saved.taskId}` } };
    });
  },
  observe: async run => {
    const observedAt = new Date(now()).toISOString();
    if (fault === "hold-success-observe") {
      writeJsonDurably(statePath("fixture-observer-held"), { runId: run.runId });
      while (!fs.existsSync(statePath("fixture-observer-release"))) await new Promise(resolve => setTimeout(resolve, 5));
    }
    if (fault === "demote-on-observe") {
      writeJsonDurably(statePath("viewer-release.json"), {
        endpoint: "http://127.0.0.1:9231", revision: "a".repeat(40), hotStateBackend: "sqlite-v1",
      });
    }
    const conversationId = `conversation_${run.taskId}`;
    if (fault === "failed-live") return { state: "failed", conversationId, quiescent: false, failure: { kind: "launch-failed", detail: "Host cleanup pending." } };
    if (fault === "quiesce-after-timeout") return { state: "ended", conversationId,
      completedAt: new Date(Date.parse(run.launchedAt ?? run.claimedAt) + 90 * minute).toISOString(), finalText: "" };
    if (!receipts()[run.runId]) return { state: "running" };
    if (fault === "host-died") return { state: "failed", conversationId, quiescent: false, failure: { kind: "host-died", detail: "Fixture host exited." } };
    if (fault === "success" || fault === "settlement-crash" || fault === "card-receipt-crash" || fault === "demote-on-observe" || fault === "hold-success-observe") {
      return { state: "ended", conversationId, finalText: [
        'Inventory summary\n```json\n{"items":1}\n```',
        'Done.\n```json\n{"verdict":"pass","kept":[{"target":"fixture","reason":"keep"}],"notes":"Checked.","removed":["invented"]}\n```',
      ].join("\n"), completedAt: observedAt };
    }
    return { state: "running", conversationId };
  },
});
const cleaner = fault === "observe-only" ? undefined : {
  ...controller,
  claimPressure: async (...args: Parameters<typeof controller.claimPressure>) => {
    const claimed = await controller.claimPressure(...args);
    if (claimed && fault === "claim-crash") end();
    return claimed;
  },
};
const actions = productionDiskPressureActions();
actions.project = async () => "repo-1234abcd";
actions.early = () => fs.appendFileSync(statePath("fixture-sweeps"), `${at}\n`);
const readPressure = async () => {
  if (fault === "switch-owner-on-read") {
    const file = statePath("viewer-release.json");
    const revision = "a".repeat(40);
    fs.writeFileSync(file, JSON.stringify({ endpoint: "http://127.0.0.1:9231", revision, hotStateBackend: "sqlite-v1" }));
    fs.writeFileSync(file, JSON.stringify({ endpoint: "http://127.0.0.1:9230", revision, hotStateBackend: "sqlite-v1" }));
    fs.utimesSync(file, new Date(now()), new Date(now()));
    publishHotStateAuthority(statePath(), "sqlite", revision, { activationReadyAt: at! });
  }
  const pressure = observeDiskPressureReport(statePath("disk-pressure-report.json"), () => [
    { roles: ["state"], freeBytes: (space === "ok" ? 500 : 10) * 1024 ** 3,
      totalBytes: 1000 * 1024 ** 3, level: space === "ok" ? "ok" : "critical" },
  ], at!);
  if (space === "ready") pressure.consumers = [{ kind: "temp", bytes: 9 * 1024 ** 3, measuredAt: at! }];
  writeJsonDurably(statePath("disk-pressure-report.json"), pressure);
  return pressure;
};

const schedule = ((run: () => void, delay: number) => {
  if (delay === 0) return setTimeout(run, 0);
  stopDiskPressureWatch();
  console.log(JSON.stringify({ active: activeCleanerRun(), pending: pendingCleanerCard(), ledger: receipts() }));
  // The watch stores its scheduled handle after the callback returns.
  queueMicrotask(stopDiskPressureWatch);
  clearTimeout(keepAlive);
  return setTimeout(() => {}, delay);
}) as typeof setTimeout;
const keepAlive = setTimeout(() => { throw new Error("watch did not finish its tick"); }, 45_000);
startDiskPressureWatch({ readPressure, actions, cleaner, now, schedule });
