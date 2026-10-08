import { testEnvironment } from "@/lib/stateOwnership";

import { telegramConnectorRecordedGone, telegramConnectorUnverified } from "./connector";
import { readTelegramConnection, readTelegramSession, type StoredTelegramConnection, type StoredTelegramSession } from "./sessionStore";

/**
 * What a launch that holds the Telegram grant finds on this installation.
 *
 * The grant check used to be one boolean: the connection record reads
 * `connected` and names the stored credential. Every other state refused the
 * launch with the same sentence, and nothing ever tried to leave that state.
 * The states differ in what a launch can do about them, so they are named:
 *
 *  - `ready`: the record and the credential agree and the recorded connector
 *    process, if one was ever recorded, is still running;
 *  - `not_set_up`: no credential is stored and the record names none. Telegram
 *    was never connected here, or the operator signed out. The server is left
 *    out and nobody is asked for anything;
 *  - `recoverable`: a credential is stored and the ordinary health check can
 *    bring the connection back with no login: the connector process ended with
 *    the machine or the container that ran it, a health check failed once, a
 *    connector started by the previous release was refused by this one, a
 *    login was interrupted between saving the credential and publishing the
 *    record;
 *  - `needs_operator`: only the operator can fix it, and `action` says how.
 *
 * Nothing here reads the session string or logs a value.
 */
export type TelegramOperatorAction =
  /** Telegram ended the session or the credential is gone: sign in again. */
  | "sign_in"
  /** The connection is in an error the Telegram panel explains. */
  | "check"
  /** A process holds the connection and cannot be confirmed as the packaged
      connector, so nothing here may stop it: it ends with a restart. */
  | "restart";

export type TelegramLaunchState =
  | { kind: "ready"; token: string }
  | { kind: "not_set_up" }
  | { kind: "recoverable" }
  | { kind: "needs_operator"; action: TelegramOperatorAction };

export function readTelegramLaunchState(): TelegramLaunchState {
  let session: StoredTelegramSession | null;
  let connection: StoredTelegramConnection;
  try {
    session = readTelegramSession();
    connection = readTelegramConnection();
  } catch {
    /* Unsafe or unreadable credential storage keeps its explicit-deletion
       contract; a launch never rewrites it. */
    return { kind: "needs_operator", action: "check" };
  }
  if (!session) {
    return connection.credentialRef === null && connection.status !== "expired"
      ? { kind: "not_set_up" }
      : { kind: "needs_operator", action: "sign_in" };
  }
  const current = connection.credentialRef === session.credentialRef;
  if (current && connection.status === "expired") return { kind: "needs_operator", action: "sign_in" };
  /* A health check cannot replace a process it may not stop, and reaches the
     same error every time. A launch does not wait for it. */
  let unverified: boolean;
  try {
    unverified = telegramConnectorUnverified();
  } catch {
    unverified = false;
  }
  if (unverified) return { kind: "needs_operator", action: "restart" };
  let processGone: boolean;
  try {
    processGone = telegramConnectorRecordedGone(session);
  } catch {
    processGone = true;
  }
  if (current && connection.status === "connected" && !processGone) return { kind: "ready", token: session.connectorToken };
  /* The connector runs and still the record is an error: the operator's own
     `telegram` entry in an account's configuration blocks registration, and a
     health check reaches the same answer every time. */
  if (current && connection.status === "error" && connection.errorCode === "host_registration_failed" && !processGone) {
    return { kind: "needs_operator", action: "check" };
  }
  return { kind: "recoverable" };
}

/** Whether an agent on this installation may be granted the Telegram tool. */
export function telegramSetUp(): boolean {
  return readTelegramLaunchState().kind !== "not_set_up";
}

/**
 * What the operator has to do before the tool works again, or null when there
 * is nothing to ask of them. A connection the health check can restore asks
 * for nothing until a check in this process has ended without restoring it:
 * before that the next start repairs it by itself.
 */
export function telegramOperatorAction(): TelegramOperatorAction | null {
  const state = readTelegramLaunchState();
  if (state.kind === "needs_operator") return state.action;
  if (state.kind !== "recoverable") return null;
  return repairHolder().failedAt !== null ? "check" : null;
}

/** How long a launch waits for the repair. A resumed host has sixty seconds to
    publish (`RESUME_PUBLICATION_BOUND_MS`) and the engine still has to start
    inside them, so the wait takes a third. A connector that needs longer, up
    to its own thirty-second readiness deadline, finishes in the background
    and the next start finds it ready. */
const REPAIR_WAIT_MS = 20_000;
/** After a repair that did not bring the connection back, launches go on
    without the tool for this long before one of them tries again. */
const REPAIR_COOLDOWN_MS = 120_000;

export interface TelegramLaunchRepairPorts {
  /** The ordinary health check: ensures the connector and republishes status. */
  healthCheck(): Promise<void>;
  now(): number;
  waitMs: number;
  cooldownMs: number;
}

const productionRepairPorts: TelegramLaunchRepairPorts = {
  healthCheck: async () => {
    /* A test run never starts the packaged connector or the login bridge. A
       test that wants a repair installs its own ports. */
    if (testEnvironment()) return;
    const { telegramService } = await import("./service");
    await telegramService().checkHealth();
  },
  now: Date.now,
  waitMs: REPAIR_WAIT_MS,
  cooldownMs: REPAIR_COOLDOWN_MS,
};

/* One repair per process, across route bundles. `running` holds every health
   check under way, whoever started it: a launch, the start of the Viewer, the
   Telegram panel, a report run. */
const REPAIR_KEY = "__llvTelegramLaunchRepair" as const;
type RepairHolder = {
  ports: TelegramLaunchRepairPorts;
  running: Set<Promise<void>>;
  shared: Promise<void> | null;
  failedAt: number | null;
};

function repairHolder(): RepairHolder {
  const holder = globalThis as typeof globalThis & { [REPAIR_KEY]?: RepairHolder };
  holder[REPAIR_KEY] ??= { ports: productionRepairPorts, running: new Set(), shared: null, failedAt: null };
  return holder[REPAIR_KEY];
}

export function setTelegramLaunchRepairForTests(ports: Partial<TelegramLaunchRepairPorts> | null): void {
  const holder = repairHolder();
  holder.ports = ports ? { ...productionRepairPorts, ...ports } : productionRepairPorts;
  holder.running = new Set();
  holder.shared = null;
  holder.failedAt = null;
}

/**
 * Registers a health check as one every launch waits for.
 *
 * A check replaces a dead connector in steps: it removes the stale process
 * record, records the new process, and only then verifies it. Between those
 * steps the record still reads `connected` over a process that is running and
 * unverified, so `ready` is trusted only while no check is under way. When the
 * check ends, the state it left decides whether the next launches try again.
 */
export function trackTelegramHealthCheck<T>(check: Promise<T>): Promise<T> {
  const holder = repairHolder();
  const settled: Promise<void> = check.then(() => undefined, () => undefined).then(() => {
    holder.running.delete(settled);
    let restored = false;
    try { restored = readTelegramLaunchState().kind === "ready"; } catch { /* unreadable reads as unrestored */ }
    holder.failedAt = restored ? null : holder.ports.now();
  });
  holder.running.add(settled);
  return check;
}

/**
 * The one health check a launch and the start of the Viewer share: a caller
 * that arrives while it runs joins it, so one check runs at a time.
 */
export function runSharedTelegramHealthCheck(): Promise<void> {
  const holder = repairHolder();
  if (!holder.shared) {
    const shared: Promise<void> = trackTelegramHealthCheck(
      (async () => { await holder.ports.healthCheck(); })(),
    ).finally(() => { if (holder.shared === shared) holder.shared = null; });
    holder.shared = shared;
  }
  return holder.shared;
}

/** Waits until no health check is under way, or until the launch's wait ends. */
async function healthChecksSettled(holder: RepairHolder, expired: Promise<"expired">): Promise<boolean> {
  while (holder.running.size > 0) {
    const outcome = await Promise.race([
      Promise.all([...holder.running]).then(() => "settled" as const),
      expired,
    ]);
    if (outcome === "expired") return false;
  }
  return true;
}

/** What a launch acts on while a check is still under way: a record that
    reads `ready` is unconfirmed, so the launch goes on without the tool. */
function unconfirmed(state: TelegramLaunchState): TelegramLaunchState {
  return state.kind === "ready" ? { kind: "recoverable" } : state;
}

/**
 * Brings a recoverable connection back, with no login, and returns the state a
 * launch should act on.
 *
 * Bounded: the caller waits at most `waitMs` in total, and a health check that
 * outlives the wait keeps running for the next caller. Idempotent: concurrent
 * launches share one check with each other and with the start of the Viewer,
 * a state that is not recoverable is returned untouched, and after a repair
 * that failed the launches of the next `cooldownMs` go on without the tool,
 * so no launch waits out the same failure again.
 */
export async function repairTelegramConnection(): Promise<TelegramLaunchState> {
  const holder = repairHolder();
  const { ports } = holder;
  const coolingDown = () => holder.failedAt !== null && ports.now() - holder.failedAt < ports.cooldownMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), ports.waitMs);
    timer.unref?.();
  });
  try {
    if (holder.running.size > 0) {
      /* An earlier launch already waited this check out. */
      if (coolingDown()) return unconfirmed(readTelegramLaunchState());
      if (!await healthChecksSettled(holder, expired)) {
        holder.failedAt = ports.now();
        return unconfirmed(readTelegramLaunchState());
      }
    }
    const before = readTelegramLaunchState();
    if (before.kind !== "recoverable" || coolingDown()) return before;
    void runSharedTelegramHealthCheck().catch(() => undefined);
    if (!await healthChecksSettled(holder, expired)) {
      holder.failedAt = ports.now();
      return unconfirmed(readTelegramLaunchState());
    }
    return readTelegramLaunchState();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
