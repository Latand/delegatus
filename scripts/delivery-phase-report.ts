import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { DeliveryProgressRecord } from "../src/lib/runtime/deliveryProgress";
import { archiveDirectory } from "../src/lib/reviewHistory/reader";
import { stateOwner } from "../src/lib/stateOwnership";

function timestamp(value: string | undefined): number {
  if (!value || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("Window timestamps must be ISO times with an explicit time zone");
  }
  return Date.parse(value);
}

function percentile(sorted: number[], fraction: number): string {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const value = sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
  return value.toFixed(1);
}

/** This command deliberately has no owner side-effect import. */
export function deliveryPhaseReport(args: string[]): string {
  if (args.length === 1 && args[0] === "--help") {
    return "Usage: LLV_STATE_DIR=<state> bun scripts/delivery-phase-report.ts --since <ISO> [--until <ISO>]";
  }
  let since: number | undefined;
  let until = Date.now();
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--since") since = timestamp(args[i + 1]);
    else if (args[i] === "--until") until = timestamp(args[i + 1]);
    else throw new Error("Expected --since and optional --until; use --help for usage");
  }
  if (since === undefined || since >= until) throw new Error("Provide --since earlier than --until");
  if (!process.env.LLV_STATE_DIR?.trim() && !stateOwner()) {
    throw new Error("Set LLV_STATE_DIR explicitly, or inherit a valid LLV_STATE_OWNER");
  }
  const filename = path.join(archiveDirectory(), "delivery-progress.sqlite");
  if (!fs.existsSync(filename)) throw new Error("No delivery progress database exists in the chosen state directory");
  const db = new Database(filename, { readonly: true, strict: true });
  const samples = new Map<string, number[]>();
  const add = (phase: string, reason: string | null, start: string | undefined | null, end: string | undefined | null) => {
    const a = start ? Date.parse(start) : NaN;
    const b = end ? Date.parse(end) : NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < since! || b < a || b > until) return;
    const key = `${phase}\t${(reason ?? "-").replace(/[\t\r\n]/g, " ")}`;
    const values = samples.get(key) ?? [];
    values.push(b - a);
    samples.set(key, values);
  };
  let records = 0;
  let missingHistory = 0;
  let truncatedHistory = 0;
  let openSpans = 0;
  try {
    db.exec("PRAGMA busy_timeout = 0");
    // Observation times do not advance updated_at or the delivery's clocks.
    const rows = db.query<{ record_json: string }, []>(
      "SELECT record_json FROM delivery_progress",
    ).iterate();
    for (const row of rows) {
      const record = JSON.parse(row.record_json) as DeliveryProgressRecord;
      const history = record.phaseHistory ?? [];
      const enteredAt = record.ingressAt ?? record.admittedAt ?? history[0]?.at;
      const entered = enteredAt ? Date.parse(enteredAt) : NaN;
      if (!Number.isFinite(entered) || entered < since || entered >= until) continue;
      records++;
      if (!history.length) missingHistory++;
      if ((record.phaseHistoryDropped ?? 0) > 0) truncatedHistory++;
      if (!record.terminal) openSpans++;
      for (let i = 0; i + 1 < history.length; i++) {
        const phase = history[i];
        add(phase.phase, phase.reason, phase.at, history[i + 1].at);
      }
      add("total:ingress-to-echo", null, record.ingressAt, record.engineEchoAt);
      if (record.terminal?.state === "delivered") {
        add("total:echo-to-confirmation", null, record.engineEchoAt, record.terminal.at);
      }
    }
  } finally {
    db.close();
  }
  const lines = [
    `Window: ${new Date(since).toISOString()} <= send ingress/admission < ${new Date(until).toISOString()}`,
    `records=${records} missing_history=${missingHistory} truncated_history=${truncatedHistory} open_spans=${openSpans}`,
    "phase\treason\tspans\tp50_ms\tp95_ms",
  ];
  for (const [key, values] of [...samples].sort(([left], [right]) => left.localeCompare(right))) {
    values.sort((left, right) => left - right);
    lines.push(`${key}\t${values.length}\t${percentile(values, 0.5)}\t${percentile(values, 0.95)}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  try { console.log(deliveryPhaseReport(process.argv.slice(2))); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Could not read delivery phase history");
    process.exitCode = 1;
  }
}
