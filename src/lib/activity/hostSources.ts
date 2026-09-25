import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import {
  dedupeCandidates,
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
import { PULL_DEFAULT_EVERY_MIN, type PullConfig } from "./pull";
import { readRequests, type LedgerRead } from "./requestLedger";
import { ActivityStore, LOCAL_HOST_KEY } from "./store";

/*
 * Where the human axis reads from (docs/design/activity-dashboard.md,
 * "Cross-host human input"): every expected host, each through the sources it
 * has. A source is pluggable — anything that answers `HostSourceRead`:
 *
 * - `ledger`: this host's request ledger, live, from its first row to now.
 *   It records requests made through Delegatus surfaces and nothing else, so
 *   it never vouches for a host: input typed into an agent's terminal on this
 *   host reaches no ledger.
 * - `ingest`: this host's transcripts, recorded into Delegatus's own store as
 *   they are indexed (`ingest.ts`), from the first record on disk up to the
 *   last pass that read every transcript.
 * - `pull`: another host's own ingest, pulled here over ssh (`pull.ts`) up to
 *   the span that host had read when it last answered.
 * - `transcripts`: export files a host's exporter wrote from its own
 *   transcripts (`scripts/export-human-input.ts`), placed under
 *   `activity/hosts/<host>/`. Each file names the span it speaks for, and it
 *   read every store of its host, terminal input included.
 *
 * The expected hosts are this one, every host named in `activity/hosts.json`,
 * and every host that has an export directory. A host is covered only where
 * a source that read all of it covers: a stretch no export speaks for is
 * unknown for the projects the host holds, however many ledger rows fall in
 * it. Those rows still count, so a figure there is a lower bound.
 */

export const DEFAULT_LOCAL_HOST = "local";

export interface HostConfigEntry {
  id: string;
  label: string | null;
  projects: "all" | string[];
  since: number | null;
  /** How this host's records reach this one, when they are pulled. */
  pull: PullConfig | null;
}

export interface HostsConfig {
  state: "ok" | "absent" | "unreadable";
  local: HostConfigEntry;
  hosts: HostConfigEntry[];
}

export type HostSourceKind = InputSource | "ingest" | "pull";

export interface HostSourceRead {
  source: HostSourceKind;
  /** `pending`: set up and not read to any point yet (a first backfill). */
  state: "read" | "absent" | "unreadable" | "pending";
  /** What the source reads: `delegatus` for requests made through Delegatus
      surfaces alone, `all` for every store of the host. Only `all` covers. */
  scope: "delegatus" | "all";
  /** The spans this source read. */
  covered: Interval[];
  inputs: HumanInput[];
  /** Records the exporter excluded, by reason. Counts only. */
  excluded: Partial<Record<ExclusionReason, number>>;
  /** When the newest export of this source was written. */
  exportedAt: number | null;
  /** When the source last finished a read: an ingest pass, a pull, an export. */
  readAt: number | null;
  /** Why its last attempt did not read, when it did not. */
  error: string | null;
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
  /** Delegatus's activity store, read-only; null before anything was recorded. */
  store(): ActivityStore | null;
}

const productionDependencies: HostSourceDependencies = {
  dir: () => statePath("activity"),
  readLedger: (fromMs, toMs) => readRequests(fromMs, toMs),
  store: () => ActivityStore.openReadOnly(),
};

const SSH_DESTINATION = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,99}$/;

function pullConfig(value: unknown): PullConfig | null {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  /* A destination is a word: never an option, never a command. */
  if (!row || typeof row.ssh !== "string" || !SSH_DESTINATION.test(row.ssh)) return null;
  const text = (field: unknown) => typeof field === "string" && field.trim() && field.length <= 300 && !field.includes("\0") ? field.trim() : null;
  const every = Number(row.everyMin);
  return {
    ssh: row.ssh,
    bun: text(row.bun),
    stateDir: text(row.stateDir),
    everyMin: Number.isFinite(every) ? Math.min(24 * 60, Math.max(1, Math.round(every))) : PULL_DEFAULT_EVERY_MIN,
  };
}

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
    pull: pullConfig(row?.pull),
  };
}

/** `activity/hosts.json`: `{ v: 1, local: { id, label }, hosts: [{ id, label, projects, since, pull? }] }`,
    where `pull` is `{ ssh, bun?, stateDir?, everyMin? }`.
    Absent, this host is `local` and no other host is expected. */
export function readHostsConfig(dir: string): HostsConfig {
  const fallback = { id: DEFAULT_LOCAL_HOST, label: null, projects: "all" as const, since: null, pull: null };
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
    return { state: "ok", local: { ...local, projects: "all", since: local.since, pull: null }, hosts: [...new Map(hosts.map((host) => [host.id, host])).values()] };
  } catch {
    return { state: "unreadable", local: fallback, hosts: [] };
  }
}

/** The local ledger as a source: every Delegatus request from its first row
    to now, and nothing typed anywhere else. */
export function ledgerSource(host: string, window: Interval, nowMs: number, read: HostSourceDependencies["readLedger"]): HostSourceRead {
  try {
    const ledger = read(window.start, window.end);
    return {
      source: "ledger",
      state: ledger.ledgerStartMs === null ? "absent" : "read",
      scope: "delegatus",
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
      readAt: ledger.ledgerStartMs === null ? null : nowMs,
      error: null,
    };
  } catch {
    return { source: "ledger", state: "unreadable", scope: "delegatus", covered: [], inputs: [], excluded: {}, exportedAt: null, readAt: null, error: null };
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
    return { source: "transcripts", state: absent ? "absent" : "unreadable", scope: "all", covered: [], inputs: [], excluded: {}, exportedAt: null, readAt: null, error: null };
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
  return { source: "transcripts", state, scope: "all", covered: unionIntervals(covered), inputs, excluded, exportedAt, readAt: exportedAt, error: null };
}

/**
 * A host's records in Delegatus's own store as a source: this host's ingest
 * (`key` `''`) or another host's pull (`key` its id). It covers the span the
 * store says was read. A source whose last read ended within its normal
 * cadence is caught up and covers to now: the index, and the ingest after it,
 * pass every four to eight minutes, and a pull adds its own interval. One
 * that stopped longer ago is behind, and the stretch since is unread.
 */
export const INGEST_CAUGHT_UP_MS = 10 * 60_000;

export function storeSource(
  kind: "ingest" | "pull",
  store: ActivityStore | null,
  key: string,
  host: string,
  window: Interval,
  nowMs: number,
  caughtUpMs: number = INGEST_CAUGHT_UP_MS,
): HostSourceRead {
  const empty = { scope: "all" as const, covered: [], inputs: [], excluded: {}, exportedAt: null, readAt: null, error: null };
  let state: ReturnType<ActivityStore["hostState"]>;
  try {
    state = store?.hostState(key) ?? null;
  } catch {
    return { source: kind, state: "unreadable", ...empty };
  }
  if (!state) return { source: kind, state: kind === "pull" ? "pending" : "absent", ...empty };
  const until = state.coveredUntil !== null && nowMs - state.coveredUntil <= caughtUpMs ? Math.max(nowMs, state.coveredUntil) : state.coveredUntil;
  const covered = state.coveredFrom !== null && until !== null && until >= state.coveredFrom
    ? [{ start: state.coveredFrom, end: until }]
    : [];
  let inputs: HumanInput[] = [];
  try {
    inputs = dedupeCandidates(store!.candidates(key, window.start, window.end, host));
  } catch {
    return { source: kind, state: "unreadable", ...empty, readAt: state.readAt, error: state.error };
  }
  return {
    source: kind,
    state: covered.length ? "read" : state.error ? "unreadable" : "pending",
    scope: "all",
    covered,
    inputs,
    excluded: state.excluded,
    exportedAt: null,
    readAt: state.readAt,
    error: state.error,
  };
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
  let store: ActivityStore | null = null;
  try {
    store = dependencies.store();
  } catch {
    /* An unreadable store reads as a source that could not be read. */
  }
  const expected: Array<HostConfigEntry & { local: boolean; configured: boolean }> = [
    { ...config.local, local: true, configured: true },
    ...config.hosts.map((host) => ({ ...host, local: false, configured: true })),
  ];
  for (const id of exported.sort()) {
    if (!expected.some((host) => host.id === id)) expected.push({ id, label: null, projects: "all", since: null, pull: null, local: false, configured: false });
  }

  const inputs: HumanInput[] = [];
  const coverage: HostCoverage[] = [];
  const hosts: HostReport[] = [];
  const ledgerSpans = new Map<string, Interval[]>();
  try {
    for (const host of expected) {
      const sources: HostSourceRead[] = [];
      if (host.local) {
        const ledger = ledgerSource(host.id, window, nowMs, dependencies.readLedger);
        sources.push(ledger);
        ledgerSpans.set(host.id, ledger.covered);
        sources.push(storeSource("ingest", store, LOCAL_HOST_KEY, host.id, window, nowMs));
      } else if (host.pull) {
        sources.push(storeSource("pull", store, host.id, host.id, window, nowMs, INGEST_CAUGHT_UP_MS + host.pull.everyMin * 60_000));
      }
      const exported = exportSource(host.id, path.join(hostsDir, host.id), window);
      /* An export is optional once a host records itself: list it only when
         one exists, or when nothing else reads the host. */
      if (exported.state !== "absent" || sources.every((source) => source.scope !== "all")) sources.push(exported);
      for (const source of sources) inputs.push(...source.inputs);
      coverage.push({
        host: host.id,
        projects: host.projects,
        since: host.since,
        covered: unionIntervals(sources.filter((source) => source.scope === "all").flatMap((source) => source.covered)),
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
  } finally {
    store?.close();
  }
  return { inputs: mergeHumanInputs(inputs, ledgerSpans), coverage, hosts, config: config.state };
}
