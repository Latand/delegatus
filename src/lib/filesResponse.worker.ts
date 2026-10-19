import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildFilesResponse } from "@/app/api/files/response";
import { writeSummaryBootstrap } from "@/lib/scanner/summaryBootstrap";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { stateDir, statePath } from "@/lib/configDir";
import { diffFilesBodies } from "@/lib/filesDelta";
import { BoardEncoder } from "@/lib/boardEncoding";
import type { FilesResponseWorkerRequest, SeatSourceWorkerRequest } from "@/lib/scanner/filesResponseWorker";
import type { StateWriteHealth } from "@/lib/state/diskFull";

/** One request frame. A whole snapshot can ride inline, so the bound is large. */
const FRAME_MAX_BYTES = 8 * 1024 * 1024;

/* stdout is the protocol channel now that this process answers many requests
   instead of exiting after one, so a stray `console.log` from anything the
   projection loads would land in the middle of a frame. Ordinary logging goes
   to stderr, which the parent already keeps as failure detail. */
const logToStderr = (...values: unknown[]): void => {
  process.stderr.write(`${values.map((value) => (typeof value === "string" ? value : String(value))).join(" ")}\n`);
};
console.log = logToStderr;
console.info = logToStderr;
console.debug = logToStderr;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workerRequest(value: unknown): FilesResponseWorkerRequest | SeatSourceWorkerRequest | null {
  if (record(value) && value.type === "seat-liveness" && record(value.query)
    && record(value.scan) && typeof value.scan.snapshotFile === "string" && typeof value.scan.epoch === "string" && Number.isInteger(value.scan.generation)
    && typeof value.query.stallAfterMs === "number" && Number.isFinite(value.query.stallAfterMs)
    && Number.isInteger(value.query.limit) && (value.query.limit as number) >= 1 && (value.query.limit as number) <= 200
    && (value.query.reconcileStructuredIdle === undefined || typeof value.query.reconcileStructuredIdle === "boolean")
    && (value.query.project === undefined || typeof value.query.project === "string")
    && (value.query.conversationId === undefined || typeof value.query.conversationId === "string")) return value as unknown as SeatSourceWorkerRequest;
  if (record(value) && typeof value.project === "string") {
    if (value.type === "seat-reports") return value as unknown as SeatSourceWorkerRequest;
    if (value.type === "seat-agenda" && typeof value.bodyFile === "string" && typeof value.now === "number" && Number.isFinite(value.now)) return value as unknown as SeatSourceWorkerRequest;
    if (value.type === "seat-rule-reports" && typeof value.at === "string" && Number.isFinite(Date.parse(value.at))) return value as unknown as SeatSourceWorkerRequest;
  }
  if (!record(value)
    || value.type !== "project"
    || typeof value.url !== "string"
    || !Array.isArray(value.headers)
    || (value.snapshotFile !== undefined && typeof value.snapshotFile !== "string")
    || (value.deltaScope !== undefined && (typeof value.deltaScope !== "string" || !/^[0-9a-f]{40}$/.test(value.deltaScope)))
    || (value.boardEpoch !== undefined && (typeof value.boardEpoch !== "string" || !value.boardEpoch || !value.deltaScope))
    || (value.deltaFrom !== undefined && (!record(value.deltaFrom)
      || typeof value.deltaFrom.bodyFile !== "string" || typeof value.deltaFrom.etag !== "string"
      || !/^"[0-9a-f]{40}"$/.test(value.deltaFrom.etag)))
    || (value.snapshot === undefined && value.snapshotFile === undefined)
    || (value.snapshot !== undefined && (
      !record(value.snapshot)
      || !Array.isArray(value.snapshot.files)
      || !Array.isArray(value.snapshot.projectCatalog)
    ))) return null;
  return value as unknown as FilesResponseWorkerRequest;
}

/** The snapshot to project, and — read from the file — the scan generation
    the file holds (#2072). A later scan can replace the file between the
    request and this read, so the parent dates the projection by this. */
function snapshotFor(request: FilesResponseWorkerRequest): {
  snapshot: NonNullable<FilesResponseWorkerRequest["snapshot"]>;
  read?: Record<string, string>;
} {
  if (request.snapshot) return { snapshot: request.snapshot };
  const persisted = JSON.parse(fs.readFileSync(request.snapshotFile!, "utf8")) as unknown;
  if (!record(persisted)
    || !record(persisted.snapshot)
    || !Array.isArray(persisted.snapshot.files)
    || !Array.isArray(persisted.snapshot.projectCatalog)) {
    throw new Error("files response worker snapshot file is invalid");
  }
  const snapshot = persisted.snapshot as unknown as NonNullable<FilesResponseWorkerRequest["snapshot"]>;
  return typeof persisted.epoch === "string" && Number.isSafeInteger(persisted.generation)
    ? { snapshot, read: { snapshotEpoch: persisted.epoch, snapshotGeneration: String(persisted.generation) } }
    : { snapshot };
}

const boardEncoder = new BoardEncoder();

async function build(request: FilesResponseWorkerRequest): Promise<Record<string, string>> {
  const { snapshot, read } = snapshotFor(request);
  const certified = request.deltaFrom;
  let encoded: ReturnType<BoardEncoder["encode"]> | undefined;
  const response = await buildFilesResponse(new Request(request.url, {
    headers: new Headers(request.headers),
  }), {
    listFilesWithProjectCatalog: async () => snapshot,
    ...(request.boardEpoch && request.deltaScope ? { encode: (data: import("@/lib/types").FilesResponse) => {
      encoded = boardEncoder.encode(request.deltaScope!, request.boardEpoch!, data as unknown as Record<string, unknown>, Date.now(),
        certified ? {
          etag: certified.etag,
          readBody: () => {
            if (path.dirname(path.resolve(certified.bodyFile)) !== path.resolve(statePath("files-response-results"))) {
              throw new Error("files response worker received an invalid delta base path");
            }
            return fs.readFileSync(certified.bodyFile, "utf8");
          },
        } : undefined);
      return encoded;
    } } : {}),
  });
  const resultDirectory = statePath("files-response-results");
  fs.mkdirSync(resultDirectory, { recursive: true, mode: 0o700 });
  const bodyFile = path.join(resultDirectory, `${process.pid}-${crypto.randomUUID()}.json`);
  const body = await response.text();
  const etag = response.headers.get("etag") ?? "";
  fs.writeFileSync(bodyFile, body, { encoding: "utf8", mode: 0o600 });
  let boardDelta: Record<string, string> = {};
  if (encoded?.delta) {
    const deltaFile = path.join(resultDirectory, `${process.pid}-${crypto.randomUUID()}.delta.json`);
    fs.writeFileSync(deltaFile, encoded.delta.body, { encoding: "utf8", mode: 0o600 });
    boardDelta = { deltaFile, deltaBase: encoded.delta.base };
  }
  const url = new URL(request.url);
  const stateWrites = ((encoded ? encoded.stateWrites : JSON.parse(body).systemHealth?.storage?.writes) as StateWriteHealth | undefined)
    ?? { state: "ok", since: null, freeBytes: null };
  if (url.searchParams.get("view") === "summary" && !url.searchParams.get("path")?.trim()
    && !new Headers(request.headers).has(VIEWER_SPAWN_CAPABILITY_HEADER)
    && stateWrites.state === "ok") {
    try { await writeSummaryBootstrap(stateDir(), body, etag, encoded ? { scope: request.deltaScope!, epoch: request.boardEpoch! } : undefined); }
    catch { console.warn("[board bootstrap] cache write failed; live response remains available"); }
  }
  return {
    bodyFile,
    stateWritesJson: JSON.stringify(stateWrites),
    contentType: response.headers.get("content-type") ?? "application/json",
    etag,
    timing: response.headers.get("server-timing") ?? "",
    ...read,
    ...(request.boardEpoch ? boardDelta : request.deltaScope ? deltaFromBase(resultDirectory, request.deltaScope, body, etag, request.deltaFrom) : {}),
  };
}

async function seatSource(request: SeatSourceWorkerRequest): Promise<Record<string, string>> {
  let value: unknown = null;
  if (request.type === "seat-liveness") {
    if (path.dirname(path.resolve(request.scan.snapshotFile)) !== path.resolve(stateDir())) throw new Error("seat liveness inventory is outside its state directory");
    const persisted = JSON.parse(await fs.promises.readFile(request.scan.snapshotFile, "utf8"));
    if (persisted.epoch !== request.scan.epoch || persisted.generation !== request.scan.generation
      || !Array.isArray(persisted.snapshot?.files) || !Array.isArray(persisted.snapshot?.projectCatalog)) throw new Error("seat liveness inventory changed or is incomplete");
    const { agentLivenessSnapshot, productionLivenessSources } = await import("@/lib/lifecycle/liveness");
    const completed = async () => ({ snapshot: persisted.snapshot, epoch: persisted.epoch, generation: persisted.generation,
      targetGeneration: persisted.generation, cacheStatus: "hit" as const, requestCount: 1, cloneDurationMs: 0 });
    value = (await agentLivenessSnapshot({ ...request.query, ...(request.query.project ? { liveOnly: true } : {}) },
      productionLivenessSources({ completedFileScan: completed }))).conversations;
  } else if (request.type === "seat-agenda") {
    if (path.dirname(path.resolve(request.bodyFile)) !== path.resolve(statePath("files-response-results"))) throw new Error("seat agenda body path is outside the worker result directory");
    const { seatAgendaAsks } = await import("@/lib/attention/seatAgenda");
    value = seatAgendaAsks(JSON.parse(await fs.promises.readFile(request.bodyFile, "utf8")), request.now, request.project);
  } else if (request.type === "seat-reports") {
    const { seatTickReportRows } = await import("@/lib/monitor/seatTickSources");
    value = seatTickReportRows(request.project);
  } else {
    const { recordSeatRuleReports } = await import("@/lib/monitor/seatTickSources");
    recordSeatRuleReports(request.project, request.at);
  }
  const directory = statePath("files-response-results");
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const bodyFile = path.join(directory, `${process.pid}-${crypto.randomUUID()}.json`);
  await fs.promises.writeFile(bodyFile, JSON.stringify(value), { mode: 0o600 });
  return { bodyFile, contentType: "application/json", etag: "", timing: "" };
}

/** Base representations kept for deltas: one per board scope in use. */
const DELTA_BASES_KEPT = 4;

/**
 * The delta from the representation this scope last built to `body` (#1994).
 * The base lives on disk beside the result files rather than in this process,
 * so a worker retired for idleness or size still answers the next revision
 * with a delta instead of making every client download the board again.
 */
function deltaFromBase(resultDirectory: string, scope: string, body: string, etag: string, certified?: FilesResponseWorkerRequest["deltaFrom"]): Record<string, string> {
  if (!/^"[0-9a-f]{40}"$/.test(etag)) return {};
  const basePath = path.join(resultDirectory, `delta-base-${scope}.json`);
  let result: Record<string, string> = {};
  if (certified && path.dirname(path.resolve(certified.bodyFile)) !== path.resolve(resultDirectory)) {
    throw new Error("files response worker received an invalid delta base path");
  }
  try {
    const stored = certified ? `${certified.etag}\n${fs.readFileSync(certified.bodyFile, "utf8")}` : fs.readFileSync(basePath, "utf8");
    const newline = stored.indexOf("\n");
    const baseEtag = stored.slice(0, newline);
    if (newline > 0 && baseEtag === etag) return {};
    if (newline > 0 && /^"[0-9a-f]{40}"$/.test(baseEtag)) {
      const deltaFile = path.join(resultDirectory, `${process.pid}-${crypto.randomUUID()}.delta.json`);
      fs.writeFileSync(deltaFile, diffFilesBodies(stored.slice(newline + 1), body, baseEtag, etag), { encoding: "utf8", mode: 0o600 });
      result = { deltaFile, deltaBase: baseEtag };
    }
  } catch (error) {
    if (certified) throw error;
    // No base yet, or an unreadable one: this build becomes the base.
  }
  const temporary = `${basePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${etag}\n${body}`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, basePath);
  const bases = fs.readdirSync(resultDirectory)
    .filter((name) => /^delta-base-[0-9a-f]{40}\.json$/.test(name))
    .map((name) => ({ name, mtimeMs: fs.statSync(path.join(resultDirectory, name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const stale of bases.slice(DELTA_BASES_KEPT)) fs.rmSync(path.join(resultDirectory, stale.name), { force: true });
  return result;
}

function reply(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** Diagnostic RSS, reported with every answer, success or not. */
function residentBytes(): number {
  try {
    return process.memoryUsage().rss;
  } catch {
    return 0;
  }
}

async function handle(frame: string): Promise<void> {
  let id = "";
  try {
    const envelope = JSON.parse(frame) as unknown;
    if (!record(envelope) || typeof envelope.id !== "string") {
      throw new Error("files response worker received an unaddressed request");
    }
    id = envelope.id;
    const request = workerRequest(envelope.request);
    if (!request) throw new Error("files response worker received an invalid request");
    reply({ id, ok: true, result: await (request.type === "project" ? build(request) : seatSource(request)), rssBytes: residentBytes() });
  } catch (error) {
    reply({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      rssBytes: residentBytes(),
    });
  }
}

/* One build at a time: each one holds a whole projection in memory, and the
   point of keeping this process alive is that the next build reuses that heap
   rather than a second copy of it. */
let queue: Promise<void> = Promise.resolve();
let buffer = "";
let ended = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const frame = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!frame.trim()) continue;
    queue = queue.then(() => handle(frame));
  }
  if (Buffer.byteLength(buffer) > FRAME_MAX_BYTES) {
    process.stderr.write("files response worker input exceeded limit\n");
    process.exit(1);
  }
});
process.stdin.on("end", () => {
  /* The parent retired this worker. Finish what it already asked for, then go
     — an answer written after the pipe closed would be lost anyway. */
  ended = true;
  void queue.then(() => { if (ended) process.exit(0); });
});
