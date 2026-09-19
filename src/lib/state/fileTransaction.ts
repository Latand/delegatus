import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { procBackend } from "@/lib/proc";

const LOCK_ATTEMPTS = 6_000;
const LOCK_WAIT_MS = 5;
const LOCK_STALE_MS = 30_000;
const SYNC_SLEEP = new Int32Array(new SharedArrayBuffer(4));

interface LockOwner {
  pid: number;
  startIdentity: string | null;
  token: string;
}

interface LockTicket {
  lockPath: string;
  queuePath: string;
  owner: LockOwner;
  ticketPath: string;
}

export class FileTransactionBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileTransactionBusyError";
  }
}

/**
 * A store lock refusal raised BEFORE the operation was admitted (#1766).
 *
 * The distinction is the whole point: an ordinary busy refusal says only that
 * the lock was contended, and a writer that throws it can already have
 * committed — releasing the lock raises the same message. This one is thrown
 * only where the mutation body provably never ran, so nothing was read,
 * written or reserved, and the caller may repeat the SAME logical request
 * under the SAME idempotency key without risking a duplicate.
 *
 * Wrap a mutation with {@link refuseBusyBeforeAdmission} rather than
 * constructing this from a bare busy error: only the code that can see whether
 * the body ran may make the claim.
 */
export class StoreBusyBeforeAdmissionError extends FileTransactionBusyError {
  /** The refusal the caller may retry under the same key. */
  readonly retryable = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "StoreBusyBeforeAdmissionError";
    if (options && "cause" in options) this.cause = options.cause;
  }
}

/**
 * Run a store mutation and classify a busy refusal that arrived before the
 * mutation body ran (#1766). `admitted` is called by the caller at the moment
 * the body starts; a busy error after that keeps its ordinary meaning, because
 * the write may have landed.
 */
export async function refuseBusyBeforeAdmission<T>(
  run: (admitted: () => void) => Promise<T> | T,
): Promise<T> {
  let admitted = false;
  try {
    return await run(() => { admitted = true; });
  } catch (error) {
    if (!admitted && error instanceof FileTransactionBusyError && !(error instanceof StoreBusyBeforeAdmissionError)) {
      throw new StoreBusyBeforeAdmissionError(error.message, { cause: error });
    }
    throw error;
  }
}

function ownerIsStale(ownerPath: string): boolean {
  try {
    const previous = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as { pid?: unknown; startIdentity?: unknown };
    if (typeof previous.pid === "number" && Number.isInteger(previous.pid) && previous.pid > 0) {
      const identity = typeof previous.startIdentity === "string" ? previous.startIdentity : null;
      if (!procBackend.pidAlive(previous.pid)) return true;
      if (identity !== null) {
        const currentIdentity = procBackend.processIdentity(previous.pid);
        return currentIdentity !== null && currentIdentity !== identity;
      }
      return false;
    }
    return Date.now() - fs.statSync(ownerPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    try {
      return Date.now() - fs.statSync(ownerPath).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

function removeIfOwned(ownerPath: string, token: string): void {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as { token?: unknown };
    if (owner.token === token) fs.rmSync(ownerPath, { force: true });
  } catch {
    // The owner may have exited after releasing or a live contender may have recovered a stale record.
  }
}

function enqueue(filePath: string): LockTicket {
  const lockPath = `${filePath}.write-lock`;
  const queuePath = `${filePath}.write-locks`;
  fs.mkdirSync(queuePath, { recursive: true, mode: 0o700 });
  const owner: LockOwner = {
    pid: process.pid,
    startIdentity: procBackend.processIdentity(process.pid),
    token: crypto.randomUUID(),
  };
  const ticketPath = path.join(
    queuePath,
    `${String(Date.now()).padStart(16, "0")}-${process.pid}-${crypto.randomUUID()}.json`,
  );
  fs.writeFileSync(ticketPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { lockPath, queuePath, owner, ticketPath };
}

function firstLiveTicket(ticket: LockTicket): string | null {
  const liveTickets: string[] = [];
  for (const entry of fs.readdirSync(ticket.queuePath).filter((candidate) => candidate.endsWith(".json")).sort()) {
    const candidate = path.join(ticket.queuePath, entry);
    if (ownerIsStale(candidate)) {
      fs.rmSync(candidate, { force: true });
      continue;
    }
    if (fs.existsSync(candidate)) liveTickets.push(candidate);
  }
  return liveTickets[0] ?? null;
}

function tryAcquire(ticket: LockTicket): number | null {
  if (firstLiveTicket(ticket) !== ticket.ticketPath) return null;
  let descriptor: number;
  try {
    descriptor = fs.openSync(ticket.lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (ownerIsStale(ticket.lockPath)) fs.rmSync(ticket.lockPath, { force: true });
    return null;
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify(ticket.owner), "utf8");
    fs.fsyncSync(descriptor);
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(ticket.lockPath, { force: true });
    throw error;
  }
}

function release(ticket: LockTicket, descriptor: number): void {
  fs.closeSync(descriptor);
  removeIfOwned(ticket.lockPath, ticket.owner.token);
}

/**
 * Run one synchronous read-modify-write transaction under the process-shared
 * FIFO lock for the target file.
 */
export function withFileTransactionSync<T>(filePath: string, busyMessage: string, operation: () => T): T {
  const ticket = enqueue(filePath);
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const descriptor = tryAcquire(ticket);
      if (descriptor === null) {
        Atomics.wait(SYNC_SLEEP, 0, 0, LOCK_WAIT_MS);
        continue;
      }
      try {
        return operation();
      } finally {
        release(ticket, descriptor);
      }
    }
    throw new FileTransactionBusyError(busyMessage);
  } finally {
    removeIfOwned(ticket.ticketPath, ticket.owner.token);
  }
}

/**
 * Run one asynchronous read-modify-write transaction under the same
 * process-shared FIFO lock used by synchronous writers.
 */
export async function withFileTransaction<T>(filePath: string, busyMessage: string, operation: () => Promise<T> | T): Promise<T> {
  const ticket = enqueue(filePath);
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const descriptor = tryAcquire(ticket);
      if (descriptor === null) {
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
        continue;
      }
      try {
        return await operation();
      } finally {
        release(ticket, descriptor);
      }
    }
    throw new FileTransactionBusyError(busyMessage);
  } finally {
    removeIfOwned(ticket.ticketPath, ticket.owner.token);
  }
}
