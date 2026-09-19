import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildFilesResponse } from "@/app/api/files/response";
import { statePath } from "@/lib/configDir";
import type { FilesResponseWorkerRequest } from "@/lib/scanner/filesResponseWorker";

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

function workerRequest(value: unknown): FilesResponseWorkerRequest | null {
  if (!record(value)
    || value.type !== "project"
    || typeof value.url !== "string"
    || !Array.isArray(value.headers)
    || (value.snapshotFile !== undefined && typeof value.snapshotFile !== "string")
    || (value.snapshot === undefined && value.snapshotFile === undefined)
    || (value.snapshot !== undefined && (
      !record(value.snapshot)
      || !Array.isArray(value.snapshot.files)
      || !Array.isArray(value.snapshot.projectCatalog)
    ))) return null;
  return value as unknown as FilesResponseWorkerRequest;
}

function snapshotFor(request: FilesResponseWorkerRequest): NonNullable<FilesResponseWorkerRequest["snapshot"]> {
  if (request.snapshot) return request.snapshot;
  const persisted = JSON.parse(fs.readFileSync(request.snapshotFile!, "utf8")) as unknown;
  if (!record(persisted)
    || !record(persisted.snapshot)
    || !Array.isArray(persisted.snapshot.files)
    || !Array.isArray(persisted.snapshot.projectCatalog)) {
    throw new Error("files response worker snapshot file is invalid");
  }
  return persisted.snapshot as unknown as NonNullable<FilesResponseWorkerRequest["snapshot"]>;
}

async function build(request: FilesResponseWorkerRequest): Promise<Record<string, string>> {
  const snapshot = snapshotFor(request);
  const response = await buildFilesResponse(new Request(request.url, {
    headers: new Headers(request.headers),
  }), {
    listFilesWithProjectCatalog: async () => snapshot,
  });
  const resultDirectory = statePath("files-response-results");
  fs.mkdirSync(resultDirectory, { recursive: true, mode: 0o700 });
  const bodyFile = path.join(resultDirectory, `${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(bodyFile, await response.text(), { encoding: "utf8", mode: 0o600 });
  return {
    bodyFile,
    contentType: response.headers.get("content-type") ?? "application/json",
    etag: response.headers.get("etag") ?? "",
    timing: response.headers.get("server-timing") ?? "",
  };
}

function reply(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** What the parent recycles on. Reported with every answer, success or not. */
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
    reply({ id, ok: true, result: await build(request), rssBytes: residentBytes() });
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
