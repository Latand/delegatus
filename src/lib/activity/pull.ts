import { spawn } from "node:child_process";

import { EXCLUSION_REASONS, REQUEST_KINDS, SURFACES, type ExclusionReason, type RequestKind, type Surface } from "./method";
import type { ActivityStore, StoredInput, StoredTurn } from "./store";

/*
 * Another host's operator input, brought here (docs/design/activity-dashboard.md,
 * "Other hosts"). A host that runs Delegatus records its own input with the
 * same ingest; this host asks it for the rows written since the last version
 * it received, over the ssh access the operator already has, and stores them
 * under that host's id. The request is one self-contained reader handed to the
 * remote Bun on stdin: nothing is installed there, and the only thing it reads
 * is the remote's `activity/records.sqlite`, read-only. Rows are keyed per
 * host, so a replayed or overlapping pull changes nothing.
 */

export interface PullConfig {
  /** An ssh destination: a `Host` alias from the operator's ssh config. */
  ssh: string;
  /** The remote Bun; `$HOME/.bun/bin/bun`, then `bun` on its PATH, when absent. */
  bun: string | null;
  /** The remote state directory, when it is not the default one. */
  stateDir: string | null;
  /** Minutes between pulls. */
  everyMin: number;
}

export const PULL_DEFAULT_EVERY_MIN = 5;
export const PULL_PAGE_ROWS = 5_000;
const PULL_MAX_PAGES = 40;
const PULL_TIMEOUT_MS = 90_000;
const PULL_OUTPUT_MAX_BYTES = 64 << 20;

/** Why a pull did not read, as the hosts table names it. */
export type PullError = "unreachable" | "timeout" | "no-ingest" | "malformed";

/**
 * The reader the remote host runs. Plain JavaScript with Bun built-ins only,
 * so it does not depend on which Delegatus version the remote checkout holds;
 * the schema of `records.sqlite` is the contract.
 */
export const REMOTE_READER = String.raw`
const { Database } = await import("bun:sqlite");
const fs = await import("node:fs");
const path = await import("node:path");
const env = process.env;
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const config = env.XDG_CONFIG_HOME || path.join(env.HOME || "", ".config");
const dirs = env.LLV_ACTIVITY_STATE_DIR ? [env.LLV_ACTIVITY_STATE_DIR]
  : env.LLV_STATE_DIR ? [env.LLV_STATE_DIR]
  : [path.join(config, "agent-log-viewer", "state"), path.join(config, "delegatus", "state")];
const file = dirs.map((dir) => path.join(dir, "activity", "records.sqlite")).find((candidate) => fs.existsSync(candidate));
if (!file) { out({ type: "state", v: 1, state: "no-ingest" }); process.exit(0); }
const after = Math.max(0, Number(env.LLV_ACTIVITY_AFTER) || 0);
const limit = Math.min(20000, Math.max(1, Number(env.LLV_ACTIVITY_LIMIT) || 5000));
const db = new Database(file, { readonly: true });
db.exec("PRAGMA busy_timeout = 5000");
let host, rows, turns, latest;
try {
  db.exec("BEGIN");
  latest = db.query("SELECT version FROM activity_meta WHERE singleton = 1").get()?.version ?? 0;
  host = db.query("SELECT covered_from, covered_until, read_at, excluded FROM activity_hosts WHERE host = ''").get();
  rows = db.query("SELECT key, version, at, project, kind, surface, hash, conversation, ids FROM activity_inputs WHERE host = '' AND version > ? ORDER BY version LIMIT ?").all(after, limit + 1).map((row) => ({ type: "input", ...row }));
  try {
    turns = db.query('SELECT key, version, conversation, project, engine, role, pipeline, stage, start, "end" FROM activity_turns WHERE host = \'\' AND version > ? ORDER BY version LIMIT ?').all(after, limit + 1).map((row) => ({ type: "turn", ...row }));
  } catch { turns = []; }
  db.exec("COMMIT");
} catch {
  out({ type: "state", v: 1, state: "no-ingest" });
  process.exit(0);
}
const page = [...rows, ...turns].sort((a, b) => a.version - b.version);
const more = page.length > limit;
page.length = Math.min(page.length, limit);
let excluded = {};
try { excluded = JSON.parse(host?.excluded ?? "{}"); } catch {}
out({ type: "state", v: 1, state: "read", coveredFrom: host?.covered_from ?? null, coveredUntil: host?.covered_until ?? null, readAt: host?.read_at ?? null, excluded, latest, more });
for (const row of page) {
  if (row.type === "turn") {
    out({ type: "turn", key: row.key, version: row.version, conversation: row.conversation, project: row.project, engine: row.engine, role: row.role, pipelineId: row.pipeline, stageId: row.stage, start: row.start, end: row.end });
    continue;
  }
  let ids = [];
  try { ids = JSON.parse(row.ids); } catch {}
  out({ type: "input", key: row.key, version: row.version, at: row.at, project: row.project, kind: row.kind, surface: row.surface, hash: row.hash, conversation: row.conversation, ids });
}
`;

/** Runs the reader on the remote host with `env` and answers its stdout. */
export type PullTransport = (env: Record<string, string>, script: string) => Promise<{ code: number | null; stdout: string; timedOut: boolean }>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function collect(child: ReturnType<typeof spawn>, script: string): ReturnType<PullTransport> {
  return new Promise((resolve) => {
    let stdout = "";
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PULL_TIMEOUT_MS);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > PULL_OUTPUT_MAX_BYTES) child.kill("SIGKILL");
      else stdout += chunk;
    });
    child.stderr!.resume();
    child.stdin!.on("error", () => { /* The remote went away; the exit code says so. */ });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "", timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, timedOut });
    });
    child.stdin!.end(script);
  });
}

/** The production transport: `ssh -o BatchMode=yes <alias>`, which never
    prompts, so a host whose key is not loaded answers unreachable. */
export function sshTransport(config: PullConfig): PullTransport {
  return (env, script) => {
    const assignments = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
    const bun = config.bun ? shellQuote(config.bun) : `"$B"`;
    const pick = config.bun ? "" : `B="$HOME/.bun/bin/bun"; [ -x "$B" ] || B=bun; `;
    const remote = `${pick}exec env ${assignments} ${bun} run -`;
    const child = spawn("ssh", [
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
      config.ssh, remote,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    return collect(child, script);
  };
}

/** A transport that runs the reader with a local Bun: the test double, and
    the same code path as the remote one after ssh. */
export function localTransport(bun: string = process.execPath): PullTransport {
  return (env, script) => collect(spawn(bun, ["run", "-"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } }), script);
}

type RemoteState = { state: "no-ingest" } | {
  state: "read";
  coveredFrom: number | null;
  coveredUntil: number | null;
  readAt: number | null;
  excluded: Partial<Record<ExclusionReason, number>>;
  /** The remote's highest version: below the cursor, its store was recreated. */
  latest: number;
  more: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const time = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null);

function parseState(line: unknown): RemoteState | null {
  const row = record(line);
  if (!row || row.type !== "state" || row.v !== 1) return null;
  if (row.state === "no-ingest") return { state: "no-ingest" };
  if (row.state !== "read") return null;
  const excluded: Partial<Record<ExclusionReason, number>> = {};
  for (const reason of EXCLUSION_REASONS) {
    const count = record(row.excluded)?.[reason];
    if (Number.isSafeInteger(count) && (count as number) > 0) excluded[reason] = count as number;
  }
  return { state: "read", coveredFrom: time(row.coveredFrom), coveredUntil: time(row.coveredUntil), readAt: time(row.readAt), excluded, latest: Number.isSafeInteger(row.latest) ? row.latest as number : 0, more: row.more === true };
}

const OPAQUE = /^[a-z]:[0-9a-f]{64}$/;

/** One row as the remote sent it, or null when any field is not what a
    store writes: a row is taken whole or not at all. */
export function parseRemoteRow(line: unknown): StoredInput | null {
  const row = record(line);
  if (!row || row.type !== "input") return null;
  if (typeof row.key !== "string" || !OPAQUE.test(row.key)
    || !Number.isSafeInteger(row.version) || (row.version as number) <= 0
    || time(row.at) === null
    || !(row.project === null || (typeof row.project === "string" && row.project.trim() && row.project.length <= 200))
    || !REQUEST_KINDS.includes(row.kind as RequestKind)
    || !SURFACES.includes(row.surface as Surface)
    || typeof row.hash !== "string" || !/^[0-9a-f]{64}$/.test(row.hash)
    || typeof row.conversation !== "string" || !/^[0-9a-f]{32}$/.test(row.conversation)
    || !Array.isArray(row.ids) || row.ids.length > 64 || !row.ids.every((id) => typeof id === "string" && OPAQUE.test(id))) return null;
  return {
    key: row.key,
    version: row.version as number,
    at: row.at as number,
    project: row.project as string | null,
    kind: row.kind as RequestKind,
    surface: row.surface as Surface,
    hash: row.hash,
    conversation: row.conversation,
    ids: row.ids as string[],
  };
}

const LABEL = /^[A-Za-z0-9._:-]{1,120}$/;

/** One agent turn as the remote sent it, or null. */
export function parseRemoteTurn(line: unknown): StoredTurn | null {
  const row = record(line);
  if (!row || row.type !== "turn") return null;
  const optional = (value: unknown) => value === null || value === undefined || (typeof value === "string" && LABEL.test(value));
  if (typeof row.key !== "string" || !OPAQUE.test(row.key)
    || !Number.isSafeInteger(row.version) || (row.version as number) <= 0
    || typeof row.conversation !== "string" || !/^[0-9a-f]{32}$/.test(row.conversation)
    || !(row.project === null || (typeof row.project === "string" && row.project.trim() && row.project.length <= 200))
    || (row.engine !== "claude" && row.engine !== "codex")
    || typeof row.role !== "string" || !LABEL.test(row.role)
    || !optional(row.pipelineId) || !optional(row.stageId)
    || time(row.start) === null || time(row.end) === null || (row.end as number) < (row.start as number)) return null;
  return {
    key: row.key,
    version: row.version as number,
    conversation: row.conversation,
    project: row.project as string | null,
    engine: row.engine,
    role: row.role,
    pipelineId: (row.pipelineId as string | null | undefined) ?? null,
    stageId: (row.stageId as string | null | undefined) ?? null,
    start: row.start as number,
    end: row.end as number,
  };
}

export interface PullResult {
  ok: boolean;
  error: PullError | null;
  pages: number;
  rows: number;
  changed: number;
}

/**
 * Pull one host: every row it wrote after the last version received, page by
 * page. The host's read span is taken from the remote only once the last page
 * is in, so a pull cut short never claims more than it holds; a failed pull
 * leaves the last span in place and names why.
 */
export async function pullHost(
  store: ActivityStore,
  host: string,
  config: PullConfig,
  transport: PullTransport,
  now: () => number = Date.now,
  pageRows: number = PULL_PAGE_ROWS,
): Promise<PullResult> {
  const result: PullResult = { ok: false, error: null, pages: 0, rows: 0, changed: 0 };
  let cursor = store.hostState(host)?.cursor ?? 0;
  const fail = (error: PullError) => {
    result.error = error;
    store.setHostState(host, { attemptAt: now(), error, cursor });
    return result;
  };
  let restarted = false;
  for (let page = 0; page < PULL_MAX_PAGES; page += 1) {
    const env: Record<string, string> = { LLV_ACTIVITY_AFTER: String(cursor), LLV_ACTIVITY_LIMIT: String(pageRows) };
    if (config.stateDir) env.LLV_ACTIVITY_STATE_DIR = config.stateDir;
    const answer = await transport(env, REMOTE_READER);
    result.pages += 1;
    if (answer.timedOut) return fail("timeout");
    if (answer.code !== 0) return fail("unreachable");
    const lines = answer.stdout.split("\n").filter((line) => line.trim());
    let parsed: unknown[];
    try {
      parsed = lines.map((line) => JSON.parse(line) as unknown);
    } catch {
      return fail("malformed");
    }
    const state = parseState(parsed[0]);
    if (!state) return fail("malformed");
    if (state.state === "no-ingest") return fail("no-ingest");
    if (state.latest < cursor && !restarted) {
      /* A recreated remote store numbers its rows from one again: read it
         whole once more. Keys make the second read idempotent. */
      restarted = true;
      cursor = 0;
      continue;
    }
    const inputs: StoredInput[] = [];
    const turns: StoredTurn[] = [];
    for (const line of parsed.slice(1)) {
      const kind = record(line)?.type;
      const row = kind === "turn" ? parseRemoteTurn(line) : parseRemoteRow(line);
      if (!row) return fail("malformed");
      if (kind === "turn") turns.push(row as StoredTurn);
      else inputs.push(row as StoredInput);
    }
    result.rows += inputs.length + turns.length;
    store.transaction(() => {
      result.changed += store.upsertPulled(host, inputs) + store.upsertPulledTurns(host, turns);
      for (const row of [...inputs, ...turns]) cursor = Math.max(cursor, row.version);
      store.setHostState(host, state.more
        ? { attemptAt: now(), cursor }
        : { attemptAt: now(), readAt: now(), error: null, cursor, coveredFrom: state.coveredFrom, coveredUntil: state.coveredUntil, excluded: state.excluded });
    });
    if (!state.more) {
      result.ok = true;
      return result;
    }
  }
  /* Still more after the page budget: the next pull continues from the cursor. */
  return result;
}
