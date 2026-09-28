import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import type { ExternalRelayOwner, ExternalRelayTarget } from "./protocol";

export type RelayTargetSettings = {
  id: string;
  name: string;
  answered_by: "install" | "service";
  fallback: "service" | "none";
  enabled: boolean;
  engine: "claude" | "codex" | null;
  model: string | null;
  effort: string | null;
  project: string | null;
  concurrency: number;
  hardCapMinutes: number;
};
export type PairedRelay = {
  id: string;
  origin: string;
  api_base: string;
  name: string;
  description: string;
  credential: string;
  owner: ExternalRelayOwner;
  pairedAt: string;
  paused: boolean;
  limits: {
    max_response_bytes: number;
    max_wait_s: number;
    max_answer_chars: number;
  };
  targets: RelayTargetSettings[];
};
export type PendingRelay = {
  id: string;
  origin: string;
  api_base: string;
  name: string;
  description: string;
  limits: PairedRelay["limits"];
  pairing_id: string;
  poll_secret: string;
  code: string;
  verify_url: string | null;
  expires_at: string;
  poll_interval_s: number;
  owner?: ExternalRelayOwner;
  targets?: ExternalRelayTarget[];
};
export type RelayStore = {
  v: 1;
  installId: string;
  label: string;
  relays: PairedRelay[];
  pending: PendingRelay[];
};
export type RunRecord = {
  requestId: string;
  leaseId: string;
  relayId: string;
  targetId: string;
  childPid: number | null;
  childIdentity: string | null;
  ownerPid: number;
  ownerIdentity: string | null;
  runDir: string;
  startedAt: string;
};
export type RunLedger = { v: 1; runs: RunRecord[] };
export const externalRelayFile = (name: "relays" | "runs") =>
  statePath(`external-relay/${name}.json`);
function read<T>(file: string, fallback: () => T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback();
    throw error;
  }
}
function write(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
export function readRelayStore(): RelayStore {
  const file = externalRelayFile("relays");
  const existed = fs.existsSync(file);
  const store = read(file, () => ({
    v: 1 as const,
    installId: randomUUID(),
    label: "Delegatus",
    relays: [],
    pending: [],
  }));
  if (
    store.v !== 1 ||
    !Array.isArray(store.relays) ||
    !Array.isArray(store.pending)
  )
    throw new Error("invalid relay store");
  if (!existed) write(file, store);
  return store;
}
export function updateRelayStore(
  change: (store: RelayStore) => RelayStore,
): RelayStore {
  const next = change(readRelayStore());
  write(externalRelayFile("relays"), next);
  return next;
}
export function readRunLedger(): RunLedger {
  const ledger = read(externalRelayFile("runs"), () => ({
    v: 1 as const,
    runs: [],
  }));
  if (ledger.v !== 1 || !Array.isArray(ledger.runs))
    throw new Error("invalid run ledger");
  return ledger;
}
export function updateRunLedger(
  change: (ledger: RunLedger) => RunLedger,
): RunLedger {
  const next = change(readRunLedger());
  write(externalRelayFile("runs"), next);
  return next;
}
export function putRun(record: RunRecord): boolean {
  let added = false;
  updateRunLedger((ledger) => {
    if (ledger.runs.some((run) => run.requestId === record.requestId))
      return ledger;
    added = true;
    return { ...ledger, runs: [...ledger.runs, record] };
  });
  return added;
}
export function changeRun(
  requestId: string,
  change: (record: RunRecord) => RunRecord,
): void {
  updateRunLedger((ledger) => ({
    ...ledger,
    runs: ledger.runs.map((run) =>
      run.requestId === requestId ? change(run) : run,
    ),
  }));
}
export function dropRun(requestId: string): void {
  updateRunLedger((ledger) => ({
    ...ledger,
    runs: ledger.runs.filter((run) => run.requestId !== requestId),
  }));
}
export function publicRelay(
  relay: PairedRelay,
): Omit<PairedRelay, "credential"> {
  const { credential: _credential, ...publicRecord } = relay;
  return publicRecord;
}
export function publicPending(
  pending: PendingRelay,
): Omit<PendingRelay, "poll_secret"> {
  const { poll_secret: _secret, ...publicRecord } = pending;
  return publicRecord;
}
