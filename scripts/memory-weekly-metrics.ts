#!/usr/bin/env bun
/* The weekly memory report: docs/design/memory-source-switch.md §6 (slice 6)
   and the weekly metrics of docs/design/memory-quality-benchmark.md §4.2.

   bun scripts/memory-weekly-metrics.ts --state-dir <dir> [--baseline FROM/TO] [--window FROM/TO]...
     [--deployments <deployments.json>]... [--held-change <ISO time>]... [--now <ISO time>]

   It copies the state database and the delivery ledger with VACUUM INTO into
   a private temporary directory, reads only the copies, and removes the
   directory it created. Without --baseline and --window it derives them from
   memory-source.json: the baseline is the 7 days before the switch press and
   each trial week starts at drainedAt. The report is JSON on stdout: counts,
   ids and project keys, never a finding, rule or note text. It claims no
   state owner, writes nothing under the state directory and needs no Viewer. */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { weeklyReport, type MetricsInput, type MetricsPipeline, type MetricsWindow } from "../src/lib/memory/weeklyMetrics";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MetricsArgs {
  stateDir: string;
  baseline?: MetricsWindow;
  windows: MetricsWindow[];
  deployments: string[];
  heldChanges: string[];
  now: string;
}

function windowArg(value: string | undefined, flag: string): MetricsWindow {
  const [from, to] = (value ?? "").split("/");
  if (!from || !to || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) throw Error(`${flag} needs FROM/TO as two ISO times, FROM before TO`);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export function parseArgs(argv: readonly string[]): MetricsArgs {
  const args: MetricsArgs = { stateDir: "", windows: [], deployments: [], heldChanges: [], now: new Date().toISOString() };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i], value = argv[i + 1];
    if (flag === "--state-dir" && value) { args.stateDir = value; i += 1; }
    else if (flag === "--baseline") { args.baseline = windowArg(value, flag); i += 1; }
    else if (flag === "--window") { args.windows.push(windowArg(value, flag)); i += 1; }
    else if (flag === "--deployments" && value) { args.deployments.push(value); i += 1; }
    else if (flag === "--held-change" && value && Number.isFinite(Date.parse(value))) { args.heldChanges.push(new Date(value).toISOString()); i += 1; }
    else if (flag === "--now" && value && Number.isFinite(Date.parse(value))) { args.now = new Date(value).toISOString(); i += 1; }
    else throw Error(`unknown or incomplete argument: ${flag}`);
  }
  if (!args.stateDir) throw Error("--state-dir is required");
  if (!!args.baseline !== args.windows.length > 0) throw Error("give --baseline with at least one --window, or neither");
  return args;
}

/** Windows from the switch record: baseline = the press minus 7 days; trial weeks from drainedAt. */
export function derivedWindows(source: { importStartedAt?: string; drainedAt?: string } | null, now: string): { baseline: MetricsWindow; windows: MetricsWindow[] } {
  if (!source?.importStartedAt) throw Error("memory-source.json has no switch press; give --baseline and --window");
  const press = Date.parse(source.importStartedAt);
  const baseline = { from: new Date(press - 7 * DAY_MS).toISOString(), to: new Date(press).toISOString(), label: "baseline" };
  const windows: MetricsWindow[] = [];
  if (source.drainedAt) {
    for (let start = Date.parse(source.drainedAt); start + 7 * DAY_MS <= Date.parse(now); start += 7 * DAY_MS) {
      windows.push({ from: new Date(start).toISOString(), to: new Date(start + 7 * DAY_MS).toISOString(), label: `trial ${windows.length + 1}` });
    }
  }
  return { baseline, windows };
}

/** VACUUM INTO a private copy; the live file is opened read-only and never written. */
function copyDatabase(file: string, directory: string, name: string): string | null {
  if (!fs.existsSync(file)) return null;
  const target = path.join(directory, name);
  const source = new Database(file, { readonly: true });
  try { source.run("VACUUM INTO ?", [target]); } finally { source.close(); }
  return target;
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export function readMetricsInput(args: MetricsArgs, scratch: string): MetricsInput {
  const state = copyDatabase(path.join(args.stateDir, "state.sqlite"), scratch, "state.sqlite");
  const ledger = copyDatabase(path.join(args.stateDir, "role-memory", "delivery.sqlite"), scratch, "delivery.sqlite");
  const rows = (collections: string[]): Record<string, unknown>[] => {
    if (!state) return [];
    const db = new Database(state, { readonly: true });
    try {
      return db.query<{ value_json: string }, string[]>(`SELECT value_json FROM state_rows WHERE collection IN (${collections.map(() => "?").join(",")}) ORDER BY collection, row_key`)
        .all(...collections).map(row => JSON.parse(row.value_json) as Record<string, unknown>);
    } finally { db.close(); }
  };
  let deliveries: MetricsInput["deliveries"] = [];
  if (ledger) {
    const db = new Database(ledger, { readonly: true });
    try {
      const table = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='deliveries'").get();
      deliveries = table ? db.query<{ body: string }, []>("SELECT body FROM deliveries ORDER BY sequence").all().map(row => JSON.parse(row.body)) : [];
    } finally { db.close(); }
  }
  const deployments = args.deployments.flatMap(file => { const value = readJson(file); return Array.isArray(value) ? value : []; });
  return {
    pipelines: rows(["pipelines", "pipelines_archive"]) as unknown as MetricsPipeline[],
    memory: rows(["role_memory"]),
    imports: rows(["role_memory_import"]),
    deliveries,
    deployments,
    workerLimit: readJson(path.join(args.stateDir, "worker-limit.json")) as MetricsInput["workerLimit"],
    heldChanges: args.heldChanges,
  };
}

export function run(argv: readonly string[]) {
  const args = parseArgs(argv);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memory-weekly-"));
  try {
    const input = readMetricsInput(args, scratch);
    const { baseline, windows } = args.baseline ? { baseline: args.baseline, windows: args.windows } : derivedWindows(readJson(path.join(args.stateDir, "memory-source.json")) as never, args.now);
    return weeklyReport(input, baseline, windows);
  } finally {
    // Only the directory this run created.
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) { process.stderr.write(`memory-weekly-metrics: ${(error as Error).message}\n`); process.exit(2); }
}
