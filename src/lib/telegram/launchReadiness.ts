import { testEnvironment } from "@/lib/stateOwnership";

import { telegramConnectorRecordedGone } from "./connector";
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
 *    bring the connection back with no login: the connector process died with
 *    the Viewer that started it, a health check failed once, a login was
 *    interrupted between saving the credential and publishing the record;
 *  - `needs_operator`: only the operator can fix it, and `action` says how.
 *
 * Nothing here reads the session string or logs a value.
 */
export type TelegramOperatorAction =
  /** Telegram ended the session or the credential is gone: sign in again. */
  | "sign_in"
  /** The connection is in an error the Telegram panel explains. */
  | "check";

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
 * is nothing to ask of them. A stored credential behind an error record means a
 * health check already failed, so it is said now rather than after the next
 * launch has tried the same repair.
 */
export function telegramOperatorAction(): TelegramOperatorAction | null {
  const state = readTelegramLaunchState();
  if (state.kind === "needs_operator") return state.action;
  if (state.kind !== "recoverable") return null;
  try {
    return readTelegramConnection().status === "error" ? "check" : null;
  } catch {
    return "check";
  }
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

/* One repair per process, across route bundles. */
const REPAIR_KEY = "__llvTelegramLaunchRepair" as const;
type RepairHolder = { ports: TelegramLaunchRepairPorts; inFlight: Promise<void> | null; failedAt: number | null };

function repairHolder(): RepairHolder {
  const holder = globalThis as typeof globalThis & { [REPAIR_KEY]?: RepairHolder };
  holder[REPAIR_KEY] ??= { ports: productionRepairPorts, inFlight: null, failedAt: null };
  return holder[REPAIR_KEY];
}

export function setTelegramLaunchRepairForTests(ports: Partial<TelegramLaunchRepairPorts> | null): void {
  const holder = repairHolder();
  holder.ports = ports ? { ...productionRepairPorts, ...ports } : productionRepairPorts;
  holder.inFlight = null;
  holder.failedAt = null;
}

/**
 * Brings a recoverable connection back, with no login, and returns the state a
 * launch should act on.
 *
 * Bounded: the caller waits at most `waitMs`, and a health check that outlives
 * the wait keeps running for the next caller. Idempotent: concurrent launches
 * share one check, a state that is not recoverable is returned untouched, and
 * after a repair that failed the launches of the next `cooldownMs` go on
 * without the tool instead of each waiting out the same failure.
 */
export async function repairTelegramConnection(): Promise<TelegramLaunchState> {
  const before = readTelegramLaunchState();
  if (before.kind !== "recoverable") return before;
  const holder = repairHolder();
  const { ports } = holder;
  if (holder.failedAt !== null && ports.now() - holder.failedAt < ports.cooldownMs) return before;
  holder.inFlight ??= ports.healthCheck()
    .catch(() => undefined)
    .finally(() => { holder.inFlight = null; });
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    holder.inFlight,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ports.waitMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  const after = readTelegramLaunchState();
  holder.failedAt = after.kind === "ready" ? null : ports.now();
  return after;
}
