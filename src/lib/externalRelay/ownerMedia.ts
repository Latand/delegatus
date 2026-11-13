import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as pause } from "node:timers/promises";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { statePath } from "@/lib/configDir";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { withoutOperationLease } from "@/lib/operationLease";
import { ExternalRelayError, relayStreamGet } from "./client";
import { ownerMediaPreparingSchema, ownerMediaRefusalSchema } from "./protocol";
import { assertOwnerHistoryCooldown, ownerHistoryDestination, ownerHistoryProduction, ownerHistoryReason,
  OWNER_HISTORY_PRIVACY, setOwnerHistoryCooldown, type OwnerHistoryPorts } from "./ownerHistory";
import type { PairedRelay } from "./store";

export const OWNER_MEDIA_LIMIT = 2 * 1024 ** 3;
const RESERVE = 2 * 1024 ** 3, RETAIN_MS = 15 * 60_000;
export const ownerMediaInputSchema = z.object({ action: z.literal("media"), chat: z.string().regex(/^-[1-9][0-9]{0,18}$/),
  messageId: z.number().int().min(1).max(2147483647), directory: z.string().max(4096).optional() }).strict();
type Input = z.infer<typeof ownerMediaInputSchema>;
const kinds = ["photo", "document", "video", "animation", "audio", "voice", "video_note"] as const;
type Kind = typeof kinds[number];
type Failure = { available: false; status: "refused"; reason: string; note: string; privacy: string; retryAfterSeconds: number | null;
  limitBytes?: number; sizeBytes?: number; freeBytes?: number; neededBytes?: number };
type Done = { available: true; status: "done"; path: string; kind: Kind; mimeType: string; size: number; sha256: string;
  fileName: string | null; source: "bot_api" | "tdlib" | null; privacy: string };
export type OwnerMediaOutcome = Failure | Done | { available: true; status: "in_progress"; phase: "queued" | "preparing" | "downloading";
  receivedBytes: number; totalBytes: number | null; retryAfterSeconds: number; privacy: string };
const privacy = `${OWNER_HISTORY_PRIVACY} Fetched files, their contents and original names are private to this conversation. Never copy them into reports, messages, tasks, commits, issues, lessons, Telegram hand-off folders or other chats.`;
const notes: Record<string, string> = {
  not_offered: "The paired service must offer relay_owner_media before history media can be fetched.",
  too_large: "Raise the paired service's TDLib ceiling and Delegatus's per-call ceiling to fetch larger files.",
  directory_refused: "Choose an existing private directory under this installation's evidence root.",
  insufficient_space: "Free enough evidence disk space for the file and the 2 GiB reserve.",
  busy: "Two media jobs are running and eight are queued; retry later.",
  incomplete: "The media length or digest could not be verified; no file was kept.",
  deadline_exceeded: "The media job exceeded its deadline or stopped receiving bytes; retry later.",
  switch_off: "The installation's owner-tools switch is off.",
};
function refused(reason: string, extra: Partial<Failure> = {}): Failure {
  return { available: false, status: "refused", reason, note: notes[reason] ?? `History media unavailable: ${reason}.`,
    retryAfterSeconds: null, privacy, ...extra };
}
class MediaFailure extends Error {
  constructor(readonly outcome: Failure, readonly code: string | null = null) { super(outcome.reason); }
}
function fail(reason: string, extra?: Partial<Failure>): never { throw new MediaFailure(refused(reason, extra)); }
const below = (root: string, file: string) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
const errno = (error: unknown): string | null => {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && ["ENOSPC", "EACCES", "EPERM", "ENOENT", "EIO", "EEXIST", "ELOOP", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(code) ? code : null;
};
const sameIdentity = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;
interface Directory { real: string; original: string; root: string; dev: number; ino: number }
interface Job {
  key: string; input: Input; directory: Directory; relay: PairedRelay; targetId: string;
  controller: AbortController; timer: ReturnType<typeof setTimeout>; started: boolean; finishedAt?: number;
  phase: "queued" | "preparing" | "downloading"; receivedBytes: number; totalBytes: number | null;
  release?: (revoke: boolean) => Promise<void>;
  evidence?: { dev: number; ino: number; mtimeMs: number; ctimeMs: number };
  result?: OwnerMediaOutcome; promise: Promise<OwnerMediaOutcome>; resolve: (result: OwnerMediaOutcome) => void;
}
export interface OwnerMediaOptions {
  evidenceRoot?: string; history?: OwnerHistoryPorts; joinMs?: number; deadlineMs?: number;
  headerMs?: number; idleMs?: number;
  /** Test-only shorter provider preparation pause. */
  retryMs?: number;
  freeBytes?: (directory: string) => Promise<number>;
  log?: (line: { cause: string; status: number | null; elapsedMs: number; receivedBytes: number; errno: string | null }) => void;
}

/** Bounded, process-owned jobs. Restart deliberately forgets them; evidence is retained. */
export class OwnerMediaRegistry {
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private running = 0;
  private closed = false;
  private readonly history: OwnerHistoryPorts;
  constructor(private readonly options: OwnerMediaOptions = {}) { this.history = options.history ?? ownerHistoryProduction; }

  private destination() {
    if (!this.history.switches().owner_tools) fail("switch_off");
    const destination = ownerHistoryDestination(this.history);
    if (destination.reason) fail(destination.reason);
    if (!destination.relay!.features?.includes("relay_owner_media")) fail("not_offered");
    return { relay: destination.relay!, targetId: destination.targetId! };
  }
  private assertCurrent(job: Job) {
    job.controller.signal.throwIfAborted();
    const current = this.destination();
    if (current.relay.id !== job.relay.id || current.relay.api_base !== job.relay.api_base || current.targetId !== job.targetId
      || current.relay.credential !== job.relay.credential || current.relay.pairedAt !== job.relay.pairedAt) fail("not_found");
  }
  private async directory(input: Input): Promise<Directory> {
    const rootPath = this.options.evidenceRoot ?? statePath("evidence");
    if (input.directory === undefined) await fs.mkdir(path.join(rootPath, "relay-media"), { recursive: true, mode: 0o700 });
    const original = input.directory ?? path.join(rootPath, "relay-media");
    if (!path.isAbsolute(original) || original.split(path.sep).includes("..")) fail("directory_refused");
    try {
      const root = await fs.realpath(rootPath), real = await fs.realpath(original), stat = await fs.stat(real);
      if (!below(root, real) || !stat.isDirectory() || (stat.mode & 0o002) || (process.getuid && stat.uid !== process.getuid())) fail("directory_refused");
      return { root, real, original, dev: stat.dev, ino: stat.ino };
    } catch { return fail("directory_refused"); }
  }
  private async checkDirectory(directory: Directory) {
    try {
      const real = await fs.realpath(directory.original), stat = await fs.stat(real);
      if (real !== directory.real || !below(await fs.realpath(directory.root), real) || !sameIdentity(directory, stat)
        || !stat.isDirectory() || (stat.mode & 0o002) || (process.getuid && stat.uid !== process.getuid())) fail("directory_refused");
    } catch { fail("directory_refused"); }
  }

  async fetch(input: unknown, caller: string): Promise<OwnerMediaOutcome> {
    try {
      const selected = this.destination();
      const parsed = ownerMediaInputSchema.safeParse(input);
      if (!parsed.success) return refused("invalid_arguments");
      const directory = await this.directory(parsed.data);
      // Every await may have changed pairing, switch, directory or admission.
      const current = this.destination();
      if (current.relay.id !== selected.relay.id || current.targetId !== selected.targetId || current.relay.credential !== selected.relay.credential) return refused("not_found");
      if (this.closed) return refused("service_error");
      this.prune();
      const key = createHash("sha256").update(JSON.stringify([caller, current.relay.id, current.relay.api_base,
        current.relay.credential, current.relay.pairedAt, current.targetId, parsed.data.chat, parsed.data.messageId, directory.real, directory.dev, directory.ino])).digest("hex");
      let job = this.jobs.get(key);
      if (!job) {
        assertOwnerHistoryCooldown(current.relay, this.history.now());
        if (this.running >= 2 && this.queue.length >= 8) return refused("busy", { retryAfterSeconds: 3 });
        const controller = new AbortController();
        let resolve!: Job["resolve"];
        const promise = new Promise<OwnerMediaOutcome>(r => { resolve = r; });
        job = { key, input: parsed.data, directory, relay: structuredClone(current.relay), targetId: current.targetId,
          controller, promise, resolve, started: false, phase: "queued", receivedBytes: 0, totalBytes: null,
          timer: setTimeout(() => controller.abort(new MediaFailure(refused("deadline_exceeded"))), this.options.deadlineMs ?? RETAIN_MS) };
        const admitted = job;
        controller.signal.addEventListener("abort", () => {
          if (!admitted.started) {
            this.queue = this.queue.filter(item => item !== admitted);
            this.finish(admitted, refused("deadline_exceeded"));
          }
        }, { once: true });
        this.jobs.set(key, job); this.queue.push(job); this.drain();
      }
      const observed = job;
      let wait: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([job.promise, new Promise<void>(r => { wait = setTimeout(r, this.options.joinMs ?? 3000); })]); }
      finally { clearTimeout(wait); }
      this.assertCurrent(observed); await this.checkDirectory(directory); this.assertCurrent(observed);
      if (observed.result?.status === "done") {
        try {
          const stat = await fs.lstat(observed.result.path);
          if (!observed.evidence || !sameIdentity(observed.evidence, stat) || stat.mtimeMs !== observed.evidence.mtimeMs
            || stat.ctimeMs !== observed.evidence.ctimeMs || !stat.isFile() || stat.nlink !== 1
            || stat.size !== observed.result.size || (stat.mode & 0o077)) throw new Error("changed_evidence");
        } catch { this.jobs.delete(observed.key); return refused("incomplete"); }
        this.assertCurrent(observed);
      }
      if (observed.result) return observed.result;
      return { available: true, status: "in_progress", phase: observed.phase, receivedBytes: observed.receivedBytes,
        totalBytes: observed.totalBytes, retryAfterSeconds: 3, privacy };
    } catch (error) { return this.failure(error); }
  }
  private failure(error: unknown): Failure {
    if (error instanceof MediaFailure) return error.outcome;
    if (error instanceof ExternalRelayError) {
      if (error.status === 413) {
        const parsed = ownerMediaRefusalSchema.safeParse(error.payload);
        if (parsed.success && parsed.data.error.code === "too_large" && parsed.data.error.limit_bytes !== undefined) {
          const { limit_bytes: limitBytes, size_bytes: sizeBytes } = parsed.data.error;
          return refused("too_large", { limitBytes, sizeBytes, note: `The paired service's limit is ${limitBytes} bytes. ${notes.too_large}` });
        }
        return refused("malformed_response");
      }
      const parsed = ownerMediaRefusalSchema.safeParse(error.payload);
      const codes: Record<number, string[]> = { 403: ["protected"], 415: ["unsupported_kind"], 422: ["no_media", "media_unavailable"] };
      if (parsed.success && codes[error.status]?.includes(parsed.data.error.code)) return refused(parsed.data.error.code);
      if (["incomplete", "deadline_exceeded", "malformed_response"].includes(error.code)) return refused(error.code);
      if (error.status === 429) return refused("rate_limited", { retryAfterSeconds: error.retryAfterSeconds });
    }
    return refused(ownerHistoryReason(error));
  }
  private prune() {
    const completed = [...this.jobs.values()].filter(job => job.finishedAt !== undefined);
    for (const job of completed) if (Date.now() - job.finishedAt! >= RETAIN_MS) this.jobs.delete(job.key);
    const retained = completed.filter(job => this.jobs.has(job.key));
    for (const job of retained.slice(0, Math.max(0, retained.length - 64))) this.jobs.delete(job.key);
  }
  private finish(job: Job, result: OwnerMediaOutcome) {
    clearTimeout(job.timer); job.result = result; job.finishedAt = Date.now();
    this.jobs.delete(job.key); this.jobs.set(job.key, job);
    job.resolve(result); this.prune();
  }
  private drain() {
    while (!this.closed && this.running < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      job.started = true; this.running++;
      // The registry owns this job's deadline and cleanup beyond the joining
      // request. A short caller lease must not release its running slot early.
      void withoutOperationLease(() => withViewerOperation("external-relay.owner-media", () => this.run(job))).then(result => this.finish(job, result), error => this.finish(job, this.failure(error)))
        .finally(() => { this.running--; this.drain(); });
    }
  }
  private async run(job: Job): Promise<OwnerMediaOutcome> {
    const started = performance.now();
    let status: number | null = null;
    try {
      for (;;) {
        this.assertCurrent(job); assertOwnerHistoryCooldown(job.relay, this.history.now()); job.phase = "preparing";
        const route = `/targets/${encodeURIComponent(job.targetId)}/owner/groups/${job.input.chat}/messages/${job.input.messageId}/media`;
        const result = await relayStreamGet(job.relay.api_base, route, job.relay.credential, async (response, signal) => {
          status = response.statusCode ?? null;
          return this.write(job, response, signal);
        }, { signal: job.controller.signal, beforeSend: () => this.assertCurrent(job), headerMs: this.options.headerMs, idleMs: this.options.idleMs });
        this.assertCurrent(job);
        if (result.status === 200) {
          await this.checkDirectory(job.directory); this.assertCurrent(job);
          await job.release?.(false); job.release = undefined;
          return result.value;
        }
        status = 202;
        const preparing = ownerMediaPreparingSchema.safeParse(result.body);
        if (!preparing.success) fail("malformed_response");
        await pause(this.options.retryMs ?? preparing.data.retry_after_s * 1000, undefined, { signal: job.controller.signal });
      }
    } catch (error) {
      if (job.release) {
        try { await job.release(true); } catch (cleanupError) { error = cleanupError; }
        job.release = undefined;
      }
      if (error instanceof ExternalRelayError && error.status === 429) {
        const seconds = setOwnerHistoryCooldown(job.relay, error.retryAfterSeconds, this.history.now());
        error = new ExternalRelayError("rate_limited", 429, seconds);
      }
      const result = this.failure(job.controller.signal.aborted ? job.controller.signal.reason : error);
      const line = { cause: result.reason, status: error instanceof ExternalRelayError ? error.status || status : status,
        elapsedMs: Math.round(performance.now() - started), receivedBytes: job.receivedBytes, errno: errno(error) };
      if (this.options.log) this.options.log(line); else console.warn(`[relay owner-media] ${JSON.stringify(line)}`);
      return result;
    }
  }

  private async write(job: Job, response: IncomingMessage, signal: AbortSignal): Promise<Done> {
    const check = () => {
      this.assertCurrent(job);
      if (signal.aborted) {
        if (signal.reason instanceof ExternalRelayError && signal.reason.code === "deadline_exceeded") throw signal.reason;
        fail("incomplete");
      }
    };
    const length = response.headers["content-length"], rawKind = response.headers["delegatus-media-kind"];
    if (typeof length !== "string" || !/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length))
      || response.headers["content-encoding"] !== undefined || typeof rawKind !== "string" || !kinds.includes(rawKind as Kind)) fail("malformed_response");
    const size = Number(length), kind = rawKind as Kind;
    if (size > OWNER_MEDIA_LIMIT) fail("too_large", { limitBytes: OWNER_MEDIA_LIMIT, sizeBytes: size, note: `The per-call limit is ${OWNER_MEDIA_LIMIT} bytes. ${notes.too_large}` });
    const mime = response.headers["content-type"];
    if (typeof mime !== "string" || mime.length > 100 || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mime)) fail("malformed_response");
    const free = this.options.freeBytes ? await this.options.freeBytes(job.directory.real) : await fs.statfs(job.directory.real).then(s => s.bavail * s.bsize);
    check(); await this.checkDirectory(job.directory); check();
    if (!Number.isFinite(free) || free < size + RESERVE) fail("insufficient_space", { freeBytes: free, neededBytes: size + RESERVE });
    const dir = await fs.open(job.directory.real, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    let part: string | undefined, linked: string | undefined, keep = false;
    try {
      check();
      if (!sameIdentity(job.directory, await dir.stat())) fail("directory_refused");
      await this.checkDirectory(job.directory); check();
      // Pin every write and cleanup to the opened directory on Linux. A renamed
      // directory cannot redirect a cleanup into its replacement.
      const anchor = process.platform === "linux" ? `/proc/self/fd/${dir.fd}` : job.directory.real;
      await this.sweepParts(anchor, job); check(); await this.checkDirectory(job.directory);
      const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "application/pdf": "pdf",
        "audio/ogg": "ogg", "audio/mpeg": "mp3" } as Record<string, string>)[mime.toLowerCase()] ?? "bin";
      const stem = `relay-${createHash("sha256").update(job.input.chat).digest("hex").slice(0, 12)}-${job.input.messageId}`;
      part = path.join(anchor, `${stem}-${randomUUID()}.${ext}.part`);
      file = await fs.open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const identity = await file.stat();
      check(); await this.checkDirectory(job.directory); check();
      job.phase = "downloading"; job.totalBytes = size;
      const hash = createHash("sha256"); let lastSwitch = 0;
      const guard = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
        try {
          job.controller.signal.throwIfAborted();
          if (signal.aborted) check();
          if (performance.now() - lastSwitch >= 1000) { check(); lastSwitch = performance.now(); }
          job.receivedBytes += chunk.length;
          if (job.receivedBytes > size || job.receivedBytes > OWNER_MEDIA_LIMIT) fail("incomplete");
          hash.update(chunk); callback(null, chunk);
        } catch (error) { callback(error as Error); }
      } });
      const handle = file;
      const writer = new Writable({ highWaterMark: 65536, write(chunk: Buffer, _encoding, callback) {
        void (async () => {
          for (let offset = 0; offset < chunk.length;) {
            signal.throwIfAborted();
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
            if (bytesWritten <= 0) throw new MediaFailure(refused("incomplete"), "EIO");
            offset += bytesWritten;
          }
        })().then(() => callback(), error => callback(error));
      } });
      try { await pipeline(response, guard, writer, { signal }); }
      catch (error) {
        if (error instanceof MediaFailure) throw error;
        check();
        throw new MediaFailure(refused(errno(error) === "ENOSPC" ? "insufficient_space" : "incomplete"), errno(error));
      }
      if (!response.complete || job.receivedBytes !== size) fail("incomplete");
      const sha256 = hash.digest("hex"), digest = response.headers["repr-digest"];
      if (digest !== undefined) {
        const match = typeof digest === "string" && /^sha-256=:([A-Za-z0-9+/]{43}=):$/.exec(digest);
        if (!match || Buffer.from(match[1]!, "base64").toString("hex") !== sha256) fail("incomplete");
      }
      await file.sync(); check(); await this.checkDirectory(job.directory); check();
      for (let suffix = 1; suffix <= 1000; suffix++) {
        const partStat = await fs.lstat(part);
        if (!partStat.isFile() || partStat.nlink !== 1 || !sameIdentity(identity, partStat)) fail("directory_refused");
        check();
        const name = `${stem}${suffix === 1 ? "" : ` (${suffix})`}.${ext}`;
        const final = path.join(anchor, name);
        try { await fs.link(part, final); linked = final; }
        catch (error) { if (errno(error) === "EEXIST") continue; throw error; }
        const finalStat = await fs.lstat(final);
        if (!finalStat.isFile() || !sameIdentity(identity, finalStat)) fail("directory_refused");
        check(); await this.checkDirectory(job.directory); check();
        await fs.unlink(part); part = undefined;
        check(); await this.checkDirectory(job.directory); check();
        const evidence = await fs.lstat(final);
        if (!evidence.isFile() || !sameIdentity(identity, evidence) || evidence.size !== size || evidence.nlink !== 1) fail("incomplete");
        job.evidence = { dev: evidence.dev, ino: evidence.ino, mtimeMs: evidence.mtimeMs, ctimeMs: evidence.ctimeMs };
        check();
        const disposition = response.headers["content-disposition"];
        const encoded = typeof disposition === "string" ? /filename\*=UTF-8''([^;\r\n]+)/i.exec(disposition) : null;
        let fileName: string | null = null;
        try { if (encoded) fileName = decodeURIComponent(encoded[1]!).slice(0, 128); } catch { /* optional display data */ }
        const source = response.headers["delegatus-media-source"];
        keep = true;
        job.release = async revoke => { try { if (revoke) await fs.unlink(final); } finally { await dir.close(); } };
        return { available: true, status: "done", path: path.join(job.directory.real, name), kind, mimeType: mime, size, sha256,
          fileName, source: source === "bot_api" || source === "tdlib" ? source : null, privacy };
      }
      return fail("busy");
    } finally {
      try { await file?.close(); }
      finally {
        try { if (part) await fs.unlink(part); }
        finally { try { if (linked && !keep) await fs.unlink(linked); } finally { if (!keep) await dir.close(); } }
      }
    }
  }
  private async sweepParts(anchor: string, job: Job) {
    const entries = await fs.opendir(anchor);
    for await (const entry of entries) {
      job.controller.signal.throwIfAborted();
      if (!entry.isFile() || !/^relay-[a-f0-9]{12}-[1-9][0-9]*-[a-f0-9-]{36}\.[a-z0-9]+\.part$/.test(entry.name)) continue;
      try {
        const file = path.join(anchor, entry.name), stat = await fs.lstat(file);
        if (stat.isFile() && stat.nlink === 1 && (!process.getuid || stat.uid === process.getuid())
          && Date.now() - stat.mtimeMs > 30 * 60_000) await fs.unlink(file);
      } catch (error) { if (errno(error) !== "ENOENT") throw error; }
    }
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) if (!job.result) job.controller.abort(new MediaFailure(refused("deadline_exceeded")));
    await Promise.all([...this.jobs.values()].map(job => job.promise));
    this.queue = [];
  }
}
const registryKey = Symbol.for("delegatus.ownerMedia.registry");
const shared = globalThis as typeof globalThis & { [registryKey]?: OwnerMediaRegistry };
export function fetchOwnerMedia(input: unknown, caller = "operator") {
  const registry = shared[registryKey] ??= new OwnerMediaRegistry();
  return registry.fetch(input, caller);
}
