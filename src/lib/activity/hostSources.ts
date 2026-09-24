import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import {
  EXCLUSION_REASONS,
  ledgerRequestId,
  mergeHumanInputs,
  parseExportLine,
  validHostId,
  type ExclusionReason,
  type ExportEvent,
  type ExportManifest,
  type HumanInput,
  type InputSource,
} from "./humanInput";
import { unionIntervals, type HostCoverage, type Interval } from "./method";
import { readRequests, type LedgerRead } from "./requestLedger";

/*
 * Where the human axis reads from (docs/design/activity-dashboard.md,
 * "Cross-host human input"): every expected host, each through the sources it
 * has. A source is pluggable — anything that answers `HostSourceRead` — and
 * the prototype has two:
 *
 * - `ledger`: this host's request ledger, live, from its first row to now.
 * - `transcripts`: export files a host's exporter wrote from its own
 *   transcripts (`scripts/export-human-input.ts`), placed under
 *   `activity/hosts/<host>/`. Each file names the span it speaks for.
 *
 * The expected hosts are this one, every host named in `activity/hosts.json`,
 * and every host that has an export directory. A host none of whose sources
 * covers a stretch leaves that stretch unknown for the projects it holds.
 */

export const DEFAULT_LOCAL_HOST = "local";

export interface HostConfigEntry {
  id: string;
  label: string | null;
  projects: "all" | string[];
  since: number | null;
}

export interface HostsConfig {
  state: "ok" | "absent" | "unreadable";
  local: HostConfigEntry;
  hosts: HostConfigEntry[];
}

export interface HostSourceRead {
  source: InputSource;
  state: "read" | "absent" | "unreadable";
  /** The spans this source speaks for completely. */
  covered: Interval[];
  inputs: HumanInput[];
  /** Records the exporter excluded, by reason. Counts only. */
  excluded: Partial<Record<ExclusionReason, number>>;
  /** When the newest export of this source was written. */
  exportedAt: number | null;
}

export interface HostReport {
  host: string;
  label: string | null;
  local: boolean;
  /** Listed in the hosts file (expected), or found by its export alone. */
  configured: boolean;
  projects: "all" | string[];
  since: number | null;
  sources: Array<Omit<HostSourceRead, "inputs"> & { inputs: number }>;
}

export interface HumanInputRead {
  inputs: HumanInput[];
  coverage: HostCoverage[];
  hosts: HostReport[];
  config: HostsConfig["state"];
}

export interface HostSourceDependencies {
  /** The activity directory: the ledger's day files, `hosts.json`, `hosts/`. */
  dir(): string;
  readLedger(fromMs: number, toMs: number): LedgerRead;
}

const productionDependencies: HostSourceDependencies = {
  dir: () => statePath("activity"),
  readLedger: (fromMs, toMs) => readRequests(fromMs, toMs),
};

function entry(value: unknown, fallbackId: string | null): HostConfigEntry | null {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const id = row?.id ?? fallbackId;
  if (!validHostId(id)) return null;
  const projects = Array.isArray(row?.projects)
    ? row.projects.filter((project): project is string => typeof project === "string" && project.trim().length > 0)
    : "all" as const;
  const since = typeof row?.since === "string" ? Date.parse(row.since) : NaN;
  return {
    id,
    label: typeof row?.label === "string" && row.label.trim() ? row.label.trim().slice(0, 60) : null,
    projects,
    since: Number.isFinite(since) ? since : null,
  };
}

/** `activity/hosts.json`: `{ v: 1, local: { id, label }, hosts: [{ id, label, projects, since }] }`.
    Absent, this host is `local` and no other host is expected. */
export function readHostsConfig(dir: string): HostsConfig {
  const fallback = { id: DEFAULT_LOCAL_HOST, label: null, projects: "all" as const, since: null };
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "hosts.json"), "utf8");
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable", local: fallback, hosts: [] };
  }
  try {
    const parsed = JSON.parse(text) as { v?: unknown; local?: unknown; hosts?: unknown };
    if (parsed.v !== 1) throw new Error("unsupported hosts file");
    const local = entry(parsed.local, DEFAULT_LOCAL_HOST) ?? fallback;
    const hosts = (Array.isArray(parsed.hosts) ? parsed.hosts : [])
      .map((value) => entry(value, null))
      .filter((host): host is HostConfigEntry => host !== null && host.id !== local.id);
    return { state: "ok", local: { ...local, projects: "all", since: local.since }, hosts: [...new Map(hosts.map((host) => [host.id, host])).values()] };
  } catch {
    return { state: "unreadable", local: fallback, hosts: [] };
  }
}

/** The local ledger as a source: complete from its first row to now. */
export function ledgerSource(host: string, window: Interval, nowMs: number, read: HostSourceDependencies["readLedger"]): HostSourceRead {
  try {
    const ledger = read(window.start, window.end);
    return {
      source: "ledger",
      state: ledger.ledgerStartMs === null ? "absent" : "read",
      covered: ledger.ledgerStartMs === null ? [] : [{ start: ledger.ledgerStartMs, end: nowMs }],
      inputs: ledger.rows.map((row) => ({
        ids: [ledgerRequestId(row.key)],
        at: row.at,
        host,
        source: "ledger",
        project: row.project,
        kind: row.kind,
        surface: row.surface,
        hash: null,
      })),
      excluded: {},
      exportedAt: null,
    };
  } catch {
    return { source: "ledger", state: "unreadable", covered: [], inputs: [], excluded: {}, exportedAt: null };
  }
}

/** A host's transcript exports as a source: the union of the spans their
    manifests name. A file whose manifest names another host, or that has no
    manifest, is unreadable and covers nothing. */
export function exportSource(host: string, hostDir: string, window: Interval): HostSourceRead {
  let names: string[];
  try {
    names = fs.readdirSync(hostDir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { source: "transcripts", state: absent ? "absent" : "unreadable", covered: [], inputs: [], excluded: {}, exportedAt: null };
  }
  const covered: Interval[] = [];
  const inputs: HumanInput[] = [];
  const excluded: Partial<Record<ExclusionReason, number>> = {};
  let exportedAt: number | null = null;
  let unreadable = false;
  for (const name of names) {
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(hostDir, name), "utf8").split("\n").filter((line) => line.trim());
    } catch {
      unreadable = true;
      continue;
    }
    const rows = lines.map(parseExportLine);
    const manifest = rows[0];
    if (!manifest || manifest.type !== "manifest" || manifest.host !== host) {
      unreadable = true;
      continue;
    }
    const head = manifest as ExportManifest;
    covered.push({ start: head.coveredFrom, end: head.coveredUntil });
    exportedAt = Math.max(exportedAt ?? 0, head.exportedAt);
    for (const reason of EXCLUSION_REASONS) if (head.excluded[reason]) excluded[reason] = (excluded[reason] ?? 0) + head.excluded[reason]!;
    for (const row of rows.slice(1)) {
      if (!row || row.type !== "input") continue;
      const event = row as ExportEvent;
      if (event.host !== host || event.at < window.start || event.at > window.end) continue;
      inputs.push({ ids: event.ids, at: event.at, host, source: "transcripts", project: event.project, kind: event.kind, surface: event.surface, hash: event.hash });
    }
  }
  const state = covered.length ? "read" : unreadable ? "unreadable" : "absent";
  return { source: "transcripts", state, covered: unionIntervals(covered), inputs, excluded, exportedAt };
}

/**
 * Human inputs from every expected host for `window`, merged and deduplicated,
 * with what each host was read for.
 */
export function readHumanInputs(
  window: Interval,
  nowMs: number,
  overrides: Partial<HostSourceDependencies> = {},
): HumanInputRead {
  const dependencies = { ...productionDependencies, ...overrides };
  const dir = dependencies.dir();
  const config = readHostsConfig(dir);
  const hostsDir = path.join(dir, "hosts");
  let exported: string[] = [];
  try {
    exported = fs.readdirSync(hostsDir, { withFileTypes: true })
      .filter((item) => item.isDirectory() && validHostId(item.name))
      .map((item) => item.name);
  } catch {
    /* No exports yet. */
  }
  const expected: Array<HostConfigEntry & { local: boolean; configured: boolean }> = [
    { ...config.local, local: true, configured: true },
    ...config.hosts.map((host) => ({ ...host, local: false, configured: true })),
  ];
  for (const id of exported.sort()) {
    if (!expected.some((host) => host.id === id)) expected.push({ id, label: null, projects: "all", since: null, local: false, configured: false });
  }

  const inputs: HumanInput[] = [];
  const coverage: HostCoverage[] = [];
  const hosts: HostReport[] = [];
  const ledgerSpans = new Map<string, Interval[]>();
  for (const host of expected) {
    const sources: HostSourceRead[] = [];
    if (host.local) {
      const ledger = ledgerSource(host.id, window, nowMs, dependencies.readLedger);
      sources.push(ledger);
      ledgerSpans.set(host.id, ledger.covered);
    }
    sources.push(exportSource(host.id, path.join(hostsDir, host.id), window));
    for (const source of sources) inputs.push(...source.inputs);
    coverage.push({
      host: host.id,
      projects: host.projects,
      since: host.since,
      covered: unionIntervals(sources.flatMap((source) => source.covered)),
    });
    hosts.push({
      host: host.id,
      label: host.label,
      local: host.local,
      configured: host.configured,
      projects: host.projects,
      since: host.since,
      sources: sources.map(({ inputs: read, ...rest }) => ({ ...rest, inputs: read.length })),
    });
  }
  return { inputs: mergeHumanInputs(inputs, ledgerSpans), coverage, hosts, config: config.state };
}
