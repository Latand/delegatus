import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { NextRequest } from "next/server";

import {
  agentRegistry,
  readOnlyConversationLookupFromSnapshot,
  type RegistryFile,
} from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { UNRESOLVED_PROJECT } from "@/lib/projects/identity";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { requestSurface } from "@/lib/view/device";

import { ledgerRowKey } from "./humanInput";
import { REQUEST_KINDS, SURFACES, type RequestKind, type Surface } from "./method";

/*
 * The operator request ledger (docs/design/activity-dashboard.md, "Privacy
 * boundary"). One row per validated direct-operator request, written at the
 * ingress that admits it, into a UTC day file. A row holds exactly six keys —
 * a version, a digest key, a time, a kind, a surface and a project — and
 * nothing else: no conversation id, path, title, text, account or device.
 *
 * Recording never throws and never refuses: the request it describes has
 * already been admitted, and a statistics outage must not take a control
 * away from the operator. A write that fails is reported once with an outcome
 * class and the row is dropped.
 */

export const LEDGER_ROW_VERSION = 1;
export const LEDGER_RETENTION_DAYS = 90;
const DAY_FILE = /^requests-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface LedgerRow {
  v: typeof LEDGER_ROW_VERSION;
  key: string;
  at: number;
  kind: RequestKind;
  surface: Surface;
  project: string | null;
}

export interface OperatorRequestInput {
  kind: RequestKind;
  /** The ingress's own idempotency key: a retry of the same request shares
      its row. Absent, the row gets a random key. */
  idempotencyKey?: string | null;
  /** The project already resolved at the ingress (a task's, a spawn's). */
  project?: string | null;
  /** Otherwise the project is resolved from the target conversation. */
  conversationId?: string | null;
  path?: string | null;
  fallbackEntry?: { project?: string | null; cwd?: string | null } | null;
}

export interface RequestLedgerDependencies {
  now(): number;
  dir(): string;
  registrySnapshot(): RegistryFile;
  report(event: string, fields: Readonly<Record<string, string | number | boolean | null>>): void;
}

const productionDependencies: RequestLedgerDependencies = {
  now: Date.now,
  dir: () => statePath("activity"),
  registrySnapshot: () => agentRegistry().readOnlySnapshot(),
  report: (event, fields) => console.error(`[activity] ${event}`, fields),
};

function dependenciesWith(overrides: Partial<RequestLedgerDependencies>): RequestLedgerDependencies {
  return { ...productionDependencies, ...overrides };
}

/** A closed set of outcome classes. The failure text never travels: an fs
    message carries the state path. */
function storageOutcome(error: unknown): string {
  if (error instanceof FileTransactionBusyError) return "busy";
  if (error instanceof SyntaxError) return "state_unreadable";
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && /^E[A-Z]{1,15}$/.test(code)) return code;
  return "unavailable";
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayFile(dir: string, date: string): string {
  return path.join(dir, `requests-${date}.jsonl`);
}

function rowKey(idempotencyKey: string | null | undefined): string {
  const key = idempotencyKey?.trim() ?? "";
  return key ? ledgerRowKey(key) : crypto.randomBytes(32).toString("hex");
}

function cleanProject(project: string | null | undefined): string | null {
  const value = project?.trim() ?? "";
  return value && value !== UNRESOLVED_PROJECT ? value : null;
}

/** The same precedence the WakaTime operator point uses. A target it cannot
    attribute yields a null project, and the request is still recorded. */
function resolveProject(input: OperatorRequestInput, dependencies: RequestLedgerDependencies): string | null {
  if (input.project !== undefined) return cleanProject(input.project);
  try {
    const lookup = readOnlyConversationLookupFromSnapshot(dependencies.registrySnapshot());
    const conversationId = input.conversationId?.trim() ?? "";
    const byId = conversationId.startsWith("conversation_")
      ? lookup.conversation(conversationId as `conversation_${string}`)
      : null;
    const suppliedPath = input.path?.trim() ?? "";
    const conversation = byId ?? (suppliedPath ? lookup.conversationForPath(suppliedPath) : null);
    const generation = conversation?.generations.at(-1);
    const fallback = input.fallbackEntry ?? null;
    return cleanProject(resolveProjectAttribution({
      projectOwnership: conversation?.projectOwnership,
      cwd: generation?.launchProfile.cwd || fallback?.cwd || undefined,
      launchProfileProject: generation?.launchProfile.project,
      fallbackProject: fallback?.project ?? undefined,
    }).project);
  } catch {
    return cleanProject(input.fallbackEntry?.project);
  }
}

function pruneExpired(dir: string, nowMs: number): void {
  const oldest = utcDate(nowMs - LEDGER_RETENTION_DAYS * DAY_MS);
  for (const name of fs.readdirSync(dir)) {
    const match = DAY_FILE.exec(name);
    if (match && match[1]! < oldest) fs.rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * Record one direct-operator request. Call it only where
 * `directOperatorActivityAuthority(request).ok`, after the request was
 * admitted. Returns the row written, or null when nothing was stored.
 */
export function recordOperatorRequest(
  request: Pick<NextRequest, "headers"> | null,
  input: OperatorRequestInput,
  overrides: Partial<RequestLedgerDependencies> = {},
): LedgerRow | null {
  const dependencies = dependenciesWith(overrides);
  try {
    const at = dependencies.now();
    if (!Number.isSafeInteger(at) || at <= 0 || !REQUEST_KINDS.includes(input.kind)) {
      dependencies.report("request_not_stored", { outcome: "invalid" });
      return null;
    }
    const row: LedgerRow = {
      v: LEDGER_ROW_VERSION,
      key: rowKey(input.idempotencyKey),
      at,
      kind: input.kind,
      surface: requestSurface(request?.headers.get("user-agent")),
      project: resolveProject(input, dependencies),
    };
    const dir = dependencies.dir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = dayFile(dir, utcDate(at));
    const created = !fs.existsSync(file);
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    if (created) {
      try {
        pruneExpired(dir, at);
      } catch (error) {
        dependencies.report("request_retention_failed", { outcome: storageOutcome(error) });
      }
    }
    return row;
  } catch (error) {
    dependencies.report("request_not_stored", { outcome: storageOutcome(error) });
    return null;
  }
}

function parseRow(line: string): LedgerRow | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.v !== LEDGER_ROW_VERSION
    || typeof row.key !== "string" || !/^[0-9a-f]{64}$/.test(row.key)
    || typeof row.at !== "number" || !Number.isSafeInteger(row.at) || row.at <= 0
    || !REQUEST_KINDS.includes(row.kind as RequestKind)
    || !SURFACES.includes(row.surface as Surface)
    || !(row.project === null || (typeof row.project === "string" && row.project.trim()))) return null;
  return {
    v: LEDGER_ROW_VERSION,
    key: row.key,
    at: row.at,
    kind: row.kind as RequestKind,
    surface: row.surface as Surface,
    project: row.project as string | null,
  };
}

function readRows(file: string): LedgerRow[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: LedgerRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = parseRow(line);
    if (row) rows.push(row);
  }
  return rows;
}

export interface LedgerRead {
  rows: LedgerRow[];
  /** The earliest request the ledger still holds, or null when it holds none. */
  ledgerStartMs: number | null;
}

/**
 * Requests with `fromMs <= at <= toMs`, deduplicated by key (the first
 * occurrence wins), oldest first, and when the ledger's history begins.
 */
export function readRequests(
  fromMs: number,
  toMs: number,
  overrides: Partial<Pick<RequestLedgerDependencies, "dir">> = {},
): LedgerRead {
  const dir = (overrides.dir ?? productionDependencies.dir)();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], ledgerStartMs: null };
    throw error;
  }
  const dates = names.flatMap((name) => DAY_FILE.exec(name)?.[1] ?? []).sort();
  let ledgerStartMs: number | null = null;
  for (const date of dates) {
    const rows = readRows(dayFile(dir, date));
    if (rows.length) {
      ledgerStartMs = Math.min(...rows.map((row) => row.at));
      break;
    }
  }
  const first = utcDate(fromMs);
  const last = utcDate(toMs);
  const seen = new Set<string>();
  const rows: LedgerRow[] = [];
  for (const date of dates) {
    if (date < first || date > last) continue;
    for (const row of readRows(dayFile(dir, date))) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      if (row.at < fromMs || row.at > toMs) continue;
      rows.push(row);
    }
  }
  rows.sort((a, b) => a.at - b.at);
  return { rows, ledgerStartMs };
}
