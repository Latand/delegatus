import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  blockingWaitRole,
  currentWaitCorrelation,
  fileTransactionCallSite,
  normalizeBlockingWaitHolderKind,
  recordBlockingWait,
  type FileLockHolder,
} from "@/lib/blockingWaits";
import { noteWriterAdmitted } from "./admissionWitness";
import { procBackend } from "@/lib/proc";

const LOCK_ATTEMPTS = 6_000;
const LOCK_WAIT_MS = 5;
const LOCK_STALE_MS = 30_000;
const SYNC_SLEEP = new Int32Array(new SharedArrayBuffer(4));
const activeAsyncTransactions = new Map<string, number>();

const KNOWN_LOCK_PARENT_SUBJECTS: ReadonlyMap<string, string> = new Map([
  ["recorded-check-host-fences", "recorded-check-host-fences/<slot>"],
  ["recorded-check-observers", "recorded-check-observers/<slot>"],
  ["seat-quota-recovery", "seat-quota-recovery/<entry>"],
  ["done-media", "done-media/owner.lock"],
  ["report-media", "report-media/owner"],
  ["prototype-reviews", "prototype-reviews/<entry>"],
  ["telegram", "telegram/<entry>"],
  ["codex-update", "codex-update/<entry>"],
]);

const KNOWN_LOCK_BASENAME_SUBJECTS: ReadonlySet<string> = new Set([
  "attempt-temp.sqlite.sweep",
  "hot-state-authority.json",
  "lifecycle-journal.json",
  "operator-settings.json",
  "worker-limit.json",
  "project-settings.json",
  "tasks-row-preparation.json",
  "disk-pressure.json",
  "disk-pressure-notices.json",
  "release-runs.json",
  "structured-user-metadata-publication",
  ".delegatus-initialization",
  "import-job",
  "publication.lock",
  "openai-api-key",
  "voice-settings.json",
  "accounts.json",
  "asks-you-settings.json",
  "companion-state.json",
  "memory-settings.json",
  "role-memory-history.json",
  "provider-settings.json",
  "loop-profiler.json",
]);

const KNOWN_BUSY_LABELS: ReadonlyMap<string, string> = new Map([
  ["recorded check host custody", "recorded-check.host-custody"],
  ["recorded-check handoff", "recorded-check.handoff"],
  ["recorded-check acknowledgement", "recorded-check.acknowledgement"],
  ["recorded-check observation", "recorded-check.observation"],
  ["attempt-temp sweep admission", "attempt-temp.sweep"],
  ["attempt evidence copy admission", "attempt-evidence.copy"],
  ["approved attempt-temp execution", "attempt-temp.approved"],
  ["temporary data retention", "temporary-data.retention"],
  ["done media is busy", "done.media"],
  ["report media is busy", "report.media"],
  ["prototype decision is busy", "prototype.decision"],
  ["prototype publication is busy", "prototype.publication"],
  ["Telegram review polls are busy", "telegram.review-polls"],
  ["Telegram review post is busy", "telegram.review-post"],
  ["operator settings are busy", "operator.settings"],
  ["worker limit store is busy", "operator.worker-limit"],
  ["hot-state authority is busy", "state.hot-authority"],
  ["retirement guard fence is busy", "state.retirement-guard"],
  ["disk pressure report is busy", "state.disk-pressure"],
  ["disk pressure notices", "state.disk-pressure-notices"],
  ["release runs busy", "release.runs"],
  ["profile-store-busy", "loop-profiler.store"],
  ["memory import busy", "memory.import"],
  ["memory source busy", "memory.source"],
  ["shared memory settings are busy", "memory.settings"],
  ["role memory history setting is busy", "memory.role-history"],
  ["metadata collection is busy", "metadata.collection"],
  ["account guard obligations are busy", "account-guard.obligations"],
  ["interruption index initialization is busy", "interruption.index"],
  ["recipient interruption evidence is busy", "interruption.evidence"],
  ["project initialization is already in progress; retry", "pipeline.initialize"],
  ["conversation migration journals are busy", "accounts.migration"],
  ["the voice settings are busy", "voice.settings"],
  ["the provider settings are busy", "provider.settings"],
  ["the key is busy", "keys.store"],
  ["companion state is busy", "voice-companion.state"],
  ["asks-you settings are busy", "asks-you.settings"],
  ["native caller proof is busy", "attention.native-proof"],
  ["Codex sub-agent observation boundary is busy", "codex.subagent-boundary"],
  ["App repository declaration is busy", "git.forge-credentials"],
]);

const KNOWN_EXPLICIT_LABELS: ReadonlySet<string> = new Set(KNOWN_BUSY_LABELS.values());

/** Maps a target lock path strictly onto a closed set of canonical subject
    tokens so untrusted directory names, account ids, usernames, or filenames
    can never enter diagnostic logs. */
export function fileTransactionSubject(filePath: string): string {
  const segments = filePath.replaceAll("\\", "/").split("/").filter(Boolean);
  const rawBase = segments.at(-1) ?? "";
  const rawParent = segments.at(-2) ?? "";
  if (rawParent === "prototype-reviews") {
    if (rawBase.endsWith(".polls.lock")) return "prototype-reviews/<id>.polls.lock";
    if (rawBase.endsWith(".telegram.lock")) return "prototype-reviews/<id>.telegram.lock";
    if (rawBase === "publication.lock") return "prototype-reviews/publication.lock";
    return "prototype-reviews/<entry>";
  }
  const parentSubject = KNOWN_LOCK_PARENT_SUBJECTS.get(rawParent);
  if (parentSubject) return parentSubject;
  if (KNOWN_LOCK_BASENAME_SUBJECTS.has(rawBase)) return rawBase;
  if (rawBase.endsWith(".pending.jsonl")) return "interruption-obligations";
  if (rawBase.endsWith(".polls.lock")) return "prototype-reviews/<id>.polls.lock";
  if (rawBase.endsWith(".telegram.lock")) return "prototype-reviews/<id>.telegram.lock";
  return "file-transaction";
}

/** Maps a wait onto a closed set of canonical operation labels (or the closed
    subject token). Arbitrary caller busy messages are never echoed into logs. */
export function fileTransactionWaitLabel(busyMessage: string, subject: string, explicitLabel?: string): string {
  const explicit = explicitLabel?.trim();
  if (explicit && KNOWN_EXPLICIT_LABELS.has(explicit)) return explicit;
  const knownBusy = KNOWN_BUSY_LABELS.get(busyMessage.trim());
  if (knownBusy) return knownBusy;
  const knownSubject = KNOWN_LOCK_BASENAME_SUBJECTS.has(subject)
    || subject === "interruption-obligations"
    || subject === "prototype-reviews/<id>.polls.lock"
    || subject === "prototype-reviews/<id>.telegram.lock"
    || subject === "prototype-reviews/publication.lock"
    || [...KNOWN_LOCK_PARENT_SUBJECTS.values()].includes(subject);
  return knownSubject ? subject : "file-transaction";
}

function parseHolderRecord(raw: string, mtimeMs: number): FileLockHolder | undefined {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; role?: unknown };
    const pid = typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
    const sameProcess = pid === process.pid;
    const fallback = sameProcess ? blockingWaitRole() : "other-process";
    const kind = normalizeBlockingWaitHolderKind(parsed.role, fallback);
    return {
      kind,
      ageMs: Math.max(0, Date.now() - mtimeMs),
      sameProcess,
    };
  } catch {
    return undefined;
  }
}

function readLockHolderSync(lockPath: string): FileLockHolder | undefined {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const stat = fs.statSync(lockPath);
    return parseHolderRecord(raw, stat.mtimeMs);
  } catch {
    return undefined;
  }
}

async function readLockHolderAsync(lockPath: string): Promise<FileLockHolder | undefined> {
  try {
    const [raw, stat] = await Promise.all([fsp.readFile(lockPath, "utf8"), fsp.stat(lockPath)]);
    return parseHolderRecord(raw, stat.mtimeMs);
  } catch {
    return undefined;
  }
}

function transactionPath(filePath: string): string { return path.resolve(filePath); }

interface LockOwner {
  pid: number;
  startIdentity: string | null;
  token: string;
  role?: string;
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

/** Legacy-file admission failed before its callback could run. */
export class FileTransactionAdmissionError extends FileTransactionBusyError {
  constructor(readonly callSite: string) { super(`state admission is busy at ${callSite}`); }
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

async function processIdentityAsync(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    return startTicks ? `${pid}:${startTicks}` : null;
  } catch { return null; }
}

function pidAliveAsyncSafe(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
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
    role: normalizeBlockingWaitHolderKind(blockingWaitRole(), "unowned"),
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

/** One nonblocking legacy-file admission attempt. The caller's async state
 * admission owns retries; the callback never ran when this defers. */
export function withFileTransactionAttempt<T>(filePath: string, busyMessage: string, operation: () => T): T {
  const ticket = enqueue(filePath);
  try {
    const descriptor = tryAcquire(ticket);
    if (descriptor === null) throw new FileTransactionAdmissionError(busyMessage);
    noteWriterAdmitted();
    try { return operation(); }
    finally { release(ticket, descriptor); }
  } finally { removeIfOwned(ticket.ticketPath, ticket.owner.token); }
}

/**
 * Run one synchronous read-modify-write transaction under the process-shared
 * FIFO lock for the target file.
 */
export function withFileTransactionSync<T>(filePath: string, busyMessage: string, operation: () => T, options: { label?: string } = {}): T {
  const startedAt = performance.now();
  let waited = false;
  let admittedAt: number | undefined;
  let holder: FileLockHolder | undefined;
  let callSiteStack: string | undefined;
  // A same-process async owner cannot make progress while this API blocks the
  // event loop. Refuse before queuing so mixed sync/async callers stay safe.
  if ((activeAsyncTransactions.get(transactionPath(filePath)) ?? 0) > 0) {
    throw new FileTransactionBusyError(busyMessage);
  }
  const ticket = enqueue(filePath);
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const descriptor = tryAcquire(ticket);
      if (descriptor === null) {
        if (!waited) {
          waited = true;
          holder = readLockHolderSync(ticket.lockPath);
          callSiteStack = new Error().stack;
        }
        // eslint-disable-next-line no-restricted-syntax -- Legacy synchronous file-transaction API still reached while serving; async API is available.
        Atomics.wait(SYNC_SLEEP, 0, 0, LOCK_WAIT_MS);
        continue;
      }
      admittedAt = performance.now();
      noteWriterAdmitted();
      try {
        return operation();
      } finally {
        release(ticket, descriptor);
      }
    }
    throw new FileTransactionBusyError(busyMessage);
  } finally {
    removeIfOwned(ticket.ticketPath, ticket.owner.token);
    if (waited) {
      const durationMs = (admittedAt ?? performance.now()) - startedAt;
      const subject = fileTransactionSubject(filePath);
      recordBlockingWait({
        site: "file-transaction",
        synchronous: true,
        durationMs,
        subject,
        correlation: currentWaitCorrelation() ?? { label: fileTransactionWaitLabel(busyMessage, subject, options.label) },
        ...(durationMs >= 50 && callSiteStack ? { callSite: fileTransactionCallSite(callSiteStack) } : {}),
        ...(holder ? { holder } : {}),
        refused: admittedAt === undefined,
      });
    }
  }
}

/**
 * Run one asynchronous read-modify-write transaction under the same
 * process-shared FIFO lock used by synchronous writers.
 */
export async function withFileTransaction<T>(filePath: string, busyMessage: string, operation: () => Promise<T> | T, options: { label?: string } = {}): Promise<T> {
  const startedAt = performance.now();
  let waited = false;
  let admittedAt: number | undefined;
  let holder: FileLockHolder | undefined;
  let callSiteStack: string | undefined;
  const ticket = enqueue(filePath);
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const descriptor = tryAcquire(ticket);
      if (descriptor === null) {
        if (!waited) {
          waited = true;
          holder = readLockHolderSync(ticket.lockPath);
          callSiteStack = new Error().stack;
        }
        await new Promise<void>(resolve => setTimeout(resolve, LOCK_WAIT_MS));
        continue;
      }
      admittedAt = performance.now();
      noteWriterAdmitted();
      try {
        const result = operation();
        // A synchronous commit releases before another in-process synchronous
        // writer can run. Only an asynchronous body holds across a microtask.
        return result && typeof (result as Promise<T>).then === "function" ? await result : result;
      } finally { release(ticket, descriptor); }
    }
    throw new FileTransactionBusyError(busyMessage);
  } finally {
    removeIfOwned(ticket.ticketPath, ticket.owner.token);
    if (waited) {
      const durationMs = (admittedAt ?? performance.now()) - startedAt;
      const subject = fileTransactionSubject(filePath);
      recordBlockingWait({
        site: "file-transaction",
        synchronous: false,
        durationMs,
        subject,
        correlation: currentWaitCorrelation() ?? { label: fileTransactionWaitLabel(busyMessage, subject, options.label) },
        ...(durationMs >= 50 && callSiteStack ? { callSite: fileTransactionCallSite(callSiteStack) } : {}),
        ...(holder ? { holder } : {}),
        refused: admittedAt === undefined,
      });
    }
  }
}

/** Async filesystem admission for paths whose publication must not perform
 * synchronous filesystem work on the Viewer loop. */
export async function withFileTransactionAsync<T>(filePath: string, busyMessage: string, operation: () => Promise<T> | T, options: { waitMs?: number; label?: string } = {}): Promise<T> {
  const startedAt = performance.now();
  let waited = false;
  let admittedAt: number | undefined;
  let holder: FileLockHolder | undefined;
  const inProcessPath = transactionPath(filePath);
  const inProcessActive = activeAsyncTransactions.get(inProcessPath) ?? 0;
  let callSiteStack: string | undefined = inProcessActive > 0 ? new Error().stack : undefined;
  activeAsyncTransactions.set(inProcessPath, inProcessActive + 1);
  try {
  const lockPath = `${filePath}.write-lock`;
  const queuePath = `${filePath}.write-locks`;
  const deadline = options.waitMs === undefined ? Infinity : startedAt + Math.max(0, options.waitMs);
  await fsp.mkdir(queuePath, { recursive: true, mode: 0o700 });
  const owner: LockOwner = { pid: process.pid, startIdentity: await processIdentityAsync(process.pid), token: crypto.randomUUID(), role: normalizeBlockingWaitHolderKind(blockingWaitRole(), "unowned") };
  const ticketPath = path.join(queuePath, `${String(Date.now()).padStart(16, "0")}-${process.pid}-${crypto.randomUUID()}.json`);
  const ticket = { lockPath, queuePath, owner, ticketPath };
  const ticketHandle = await fsp.open(ticketPath, "wx", 0o600);
  try {
    await ticketHandle.writeFile(JSON.stringify(owner));
    await ticketHandle.close();
  } catch (error) {
    await ticketHandle.close().catch(() => undefined);
    await fsp.rm(ticketPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const ownerIsStaleAsync = async (ownerPath: string): Promise<boolean> => {
    try {
      const previous = JSON.parse(await fsp.readFile(ownerPath, "utf8")) as { pid?: unknown; startIdentity?: unknown };
      if (typeof previous.pid === "number" && Number.isInteger(previous.pid) && previous.pid > 0) {
        if (!pidAliveAsyncSafe(previous.pid)) return true;
        const expected = typeof previous.startIdentity === "string" ? previous.startIdentity : null;
        if (expected !== null) {
          const actual = await processIdentityAsync(previous.pid);
          return actual !== null && actual !== expected;
        }
        return false;
      }
      return Date.now() - (await fsp.stat(ownerPath)).mtimeMs > LOCK_STALE_MS;
    } catch {
      try { return Date.now() - (await fsp.stat(ownerPath)).mtimeMs > LOCK_STALE_MS; }
      catch { return false; }
    }
  };
  const removeOwnedAsync = async (ownerPath: string, token: string) => {
    try {
      const value = JSON.parse(await fsp.readFile(ownerPath, "utf8")) as { token?: unknown };
      if (value.token === token) await fsp.rm(ownerPath, { force: true });
    } catch { /* The owner exited or another contender recovered its stale record. */ }
  };
  const firstLiveTicketAsync = async (): Promise<string | null> => {
    const entries = (await fsp.readdir(queuePath)).filter(name => name.endsWith(".json")).sort();
    for (const entry of entries) {
      const candidate = path.join(queuePath, entry);
      if (await ownerIsStaleAsync(candidate)) await fsp.rm(candidate, { force: true });
      else {
        try { await fsp.access(candidate); return candidate; }
        catch { /* Removed after the directory read. */ }
      }
    }
    return null;
  };
  const acquireAsync = async (): Promise<import("node:fs/promises").FileHandle | null> => {
    if (await firstLiveTicketAsync() !== ticketPath) return null;
    let handle: import("node:fs/promises").FileHandle;
    try { handle = await fsp.open(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await ownerIsStaleAsync(lockPath)) await fsp.rm(lockPath, { force: true });
      return null;
    }
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); return handle; }
    catch (error) { await handle.close(); await fsp.rm(lockPath, { force: true }); throw error; }
  };
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      if (performance.now() >= deadline) throw new FileTransactionBusyError(busyMessage);
      const handle = await acquireAsync();
      if (handle === null) {
        if (!waited) {
          waited = true;
          holder = await readLockHolderAsync(lockPath);
          callSiteStack ??= new Error().stack;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(LOCK_WAIT_MS, Math.max(0, deadline - performance.now()))));
        continue;
      }
      if (performance.now() >= deadline) {
        await handle.close();
        await removeOwnedAsync(lockPath, owner.token);
        throw new FileTransactionBusyError(busyMessage);
      }
      admittedAt = performance.now();
      noteWriterAdmitted();
      try {
        const result = operation();
        // A synchronous commit releases before another in-process synchronous
        // writer can run. Only an asynchronous body holds across a microtask.
        return result && typeof (result as Promise<T>).then === "function" ? await result : result;
      } finally {
        await handle.close();
        await removeOwnedAsync(lockPath, owner.token);
      }
    }
    throw new FileTransactionBusyError(busyMessage);
  } finally {
    await removeOwnedAsync(ticket.ticketPath, owner.token);
    if (waited) {
      const durationMs = (admittedAt ?? performance.now()) - startedAt;
      const subject = fileTransactionSubject(filePath);
      recordBlockingWait({
        site: "file-transaction",
        synchronous: false,
        durationMs,
        subject,
        correlation: currentWaitCorrelation() ?? { label: fileTransactionWaitLabel(busyMessage, subject, options.label) },
        ...(durationMs >= 50 && callSiteStack ? { callSite: fileTransactionCallSite(callSiteStack) } : {}),
        ...(holder ? { holder } : {}),
        refused: admittedAt === undefined,
      });
    }
  }
  } finally {
    const remaining = (activeAsyncTransactions.get(inProcessPath) ?? 1) - 1;
    if (remaining > 0) activeAsyncTransactions.set(inProcessPath, remaining);
    else activeAsyncTransactions.delete(inProcessPath);
  }
}
