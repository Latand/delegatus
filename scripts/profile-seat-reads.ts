import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { normalizeRegistry } from "../src/lib/agent/registry";
import { registryRowsMatching, SqliteAgentRegistryStore } from "../src/lib/agent/sqliteRegistryStore";
import { canonicalProject, persistProjectAliases, projectAliasSnapshot, withProjectAliasSnapshot } from "../src/lib/projects/aliases";
import { ruleReports } from "../src/lib/monitor/ruleReports";
import { seatReadRegistry, seatReadBoard, SEAT_READ_AT, SEAT_READ_NOW } from "../src/lib/monitor/seatReads.fixture";
import { seatAgendaAsks } from "../src/lib/attention/seatAgenda";
import { needsYouAnswer } from "../src/lib/attention/needsYouProjection";

/** Run inside check-source's private state. Each registry sample is a fresh
 * process and reader; board samples reuse the same prepared board and stores.
 * Timings are diagnostic; payload and filesystem counts are deterministic. */
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const filename = process.argv[3];
if (process.argv[2] === "--registry-before" || process.argv[2] === "--registry-after") {
  let rows = 0;
  const store = new SqliteAgentRegistryStore(filename!, { readOnly: true, initialSnapshot: () => { throw new Error("profile database missing"); }, normalize: normalizeRegistry,
    onRowPayloadRead: (collection, count) => { if (collection === "heldDeliveries") rows += count; } });
  try {
    const preparationStarted = performance.now();
    const snapshot = store.readOnlySnapshot().file;
    const preparationMs = performance.now() - preparationStarted;
    rows = 0;
    const started = performance.now();
    const deliveries = process.argv[2] === "--registry-before" ? Object.values(snapshot.heldDeliveries)
      : registryRowsMatching(snapshot, "heldDeliveries", "state", "failed");
    const output = ruleReports({ project: "current", seatConversationId: "conversation_seat", locale: "en", at: SEAT_READ_AT,
      tasks: [], pipelines: [], maintenance: [], dismissals: [], deliveries,
      deliveryLost: row => snapshot.deliveryOperationOwners[row.command.operationId]?.terminalDisposition === "lost",
      deliveryProject: row => row.command.origin?.project === "old" ? "current" : row.command.origin?.project ?? null,
    });
    console.log(JSON.stringify({ ms: performance.now() - started, preparationMs, selectedRows: deliveries.length, rows, peakRssMiB: process.resourceUsage().maxRSS / 1024, hash: hash(output) }));
  } finally { store.close(); }
} else {
  if (!process.env.LLV_STATE_DIR || !process.env.LLV_VIEWER_CONTROL_URL?.endsWith(":1")) throw new Error("profile requires private state and a closed Viewer control port");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "seat-read-profile-"));
  const database = path.join(scratch, "registry.sqlite");
  try {
    const initial = seatReadRegistry();
    for (const delivery of Object.values(initial.heldDeliveries)) {
      delivery.createdAt = "2020-01-01T00:00:00.000Z";
      if (delivery.deliveredAt) delivery.deliveredAt = delivery.createdAt;
    }
    const seed = new SqliteAgentRegistryStore(database, { initialSnapshot: initial, normalize: normalizeRegistry });
    while (seed.archiveInactive(4_096) > 0) { /* retain history in its real cold-row representation */ }
    seed.close();
    const samples = { before: [] as Array<{ ms: number; selectedRows: number; rows: number; peakRssMiB: number; hash: string }>, after: [] as Array<{ ms: number; selectedRows: number; rows: number; peakRssMiB: number; hash: string }> };
    for (let round = 0; round < 5; round++) for (const mode of ["before", "after"] as const) {
      const child = spawnSync(process.execPath, [import.meta.path, `--registry-${mode}`, database], { env: process.env, encoding: "utf8", timeout: 60_000 });
      if (child.status !== 0) throw new Error(`registry ${mode} failed: ${child.stderr}`);
      samples[mode].push(JSON.parse(child.stdout));
    }
    if (new Set([...samples.before, ...samples.after].map(row => row.hash)).size !== 1) throw new Error("registry outputs differ");
    if (samples.before.some(row => row.selectedRows !== 34_623 || row.rows < 34_623) || samples.after.some(row => row.selectedRows !== 752 || row.rows !== 752)) throw new Error(`registry payload selection did not match the fixture: ${JSON.stringify(samples)}`);
    persistProjectAliases([{ source: "old", target: "current", displayName: "Fixture" }]);
    const body = seatReadBoard();
    const projectFilter = () => body.tasks.filter(row => canonicalProject(row.project) === "current");
    const agenda = () => {
      const forms = needsYouAnswer({ ...body, files: [] }, null, SEAT_READ_NOW, "current", {
        tasks: body.tasks, pipelines: body.pipelines, dismissals: [], reports: null, admissions: [], unavailable: [], seatConversationId: "conversation_seat",
      }, { kinds: ["prototype", "lane-decision", "lane-review"], full: true }, "stale-first", { rows: Number.MAX_SAFE_INTEGER, bytes: Infinity });
      return { asks: seatAgendaAsks(body, SEAT_READ_NOW, "current"), forms: { rows: forms.rows, count: forms.count, routedToSeat: forms.routedToSeat } };
    };
    // Warm lazy store imports before either measurement. Snapshot acquisition
    // remains inside the after measurement, including all five metadata probes.
    projectFilter(); agenda();
    function measure(operation: () => unknown, scoped: boolean) {
      const times: number[] = [], counts: number[] = [], hashes: string[] = [];
      for (let round = 0; round < 7; round++) {
        let stats = 0;
        const original = fs.statSync;
        Object.defineProperty(fs, "statSync", { configurable: true, value: (...args: Parameters<typeof original>) => { stats++; return original(...args); } });
        try {
          const start = performance.now();
          const output = scoped ? withProjectAliasSnapshot(projectAliasSnapshot(), operation) : operation();
          times.push(performance.now() - start); counts.push(stats); hashes.push(hash(output));
        } finally { Object.defineProperty(fs, "statSync", { configurable: true, value: original }); }
      }
      return { medianMs: median(times), statSync: counts, hash: hashes[0], stable: new Set(hashes).size === 1, samplesMs: times };
    }
    const board = { before: measure(projectFilter, false), after: measure(projectFilter, true) };
    const projection = { before: measure(agenda, false), after: measure(agenda, true) };
    for (const comparison of [board, projection]) if (!comparison.before.stable || !comparison.after.stable || comparison.before.hash !== comparison.after.hash) throw new Error("board outputs differ");
    const registry = Object.fromEntries((["before", "after"] as const).map(mode => [mode, {
      medianMs: median(samples[mode].map(row => row.ms)), rows: samples[mode].map(row => row.rows),
      medianPeakRssMiB: median(samples[mode].map(row => row.peakRssMiB)), samples: samples[mode],
    }]));
    console.log(JSON.stringify({ fixture: { deliveries: 34_623, failed: 752, tasks: body.tasks.length, files: body.files.length, pipelines: body.pipelines.length }, registry, board, agenda: projection }, null, 2));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
