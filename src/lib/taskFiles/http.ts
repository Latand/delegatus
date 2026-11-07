import fs from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import { artifactResponseHeaders, parseByteRange, SNIFF_BYTES, sniffAgrees } from "@/lib/artifact/serve";
import type { Pipeline } from "@/lib/pipelines/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ExecPort } from "@/lib/workflows/provision";
import { workspaceDenied } from "@/lib/team/workspaceRoute";
import { Aborted, type TaskFilesCaches } from "./cache";
import { LANES_PER_REQUEST } from "./limits";
import { documentBaseDir, laneFiles, PREVIEW_MAX_BYTES, readBlob, resolveFile, SHA_RE, type FileFailure, type TaskFilesLane } from "./files";

/* The two task file routes (docs/design/task-file-preview.md §6.2, §6.3). The
   workspace gate has already checked the task's project; every lane is
   checked here, on every request, against the record read by key. Caches hold
   Git facts and committed bytes, never a decision. */

export type TaskFilesScope = { canReadFile: (project: string | null | undefined) => boolean } | null;

export type TaskFilesDependencies = {
  task: (id: string) => { id: string } | null;
  pipeline: (id: string) => Pipeline | null;
  scope: (req: NextRequest) => TaskFilesScope;
  exec: ExecPort;
  caches: TaskFilesCaches;
};

export { LANES_PER_REQUEST };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_MAX = 1_024;

type Refusal = NextResponse<{ error: string; code: string }>;
const refuse = (status: number, code: string, error: string, headers?: Record<string, string>): Refusal =>
  NextResponse.json({ error, code }, { status, headers: { "cache-control": "private, no-store", ...headers } });

function failure(result: FileFailure): Refusal {
  return refuse(result.status, result.code, result.error, result.retryAfter ? { "retry-after": String(result.retryAfter) } : undefined);
}

/** A lane the caller may see for this task: bound to it, and readable. */
function admittedLane(req: NextRequest, taskId: string, laneId: string, deps: TaskFilesDependencies): Pipeline | "forbidden" | null {
  const lane = deps.pipeline(laneId);
  if (!lane || !Array.isArray(lane.taskIds) || !lane.taskIds.includes(taskId)) return null;
  const scope = deps.scope(req);
  if (scope && !scope.canReadFile(lane.project)) return "forbidden";
  return lane;
}

/** GET /api/tasks/[id]/files?lanes=a,b — the committed files of the task's lanes. */
export async function taskFilesGET(req: NextRequest, taskId: string, deps: TaskFilesDependencies): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection as Refusal;
  if (!deps.task(taskId)) return refuse(404, "task_not_found", "task not found");
  const ids = [...new Set((req.nextUrl.searchParams.get("lanes") ?? "").split(",").filter(Boolean))];
  if (!ids.length || ids.length > LANES_PER_REQUEST || ids.some((id) => !ID_RE.test(id))) {
    return refuse(400, "invalid_request", `lanes is 1 to ${LANES_PER_REQUEST} lane ids`);
  }
  let omitted = 0;
  const lanes: Pipeline[] = [];
  for (const id of ids) {
    const lane = admittedLane(req, taskId, id, deps);
    if (lane && lane !== "forbidden") lanes.push(lane);
    else omitted += 1;
  }
  const answered = await Promise.all(lanes.map((lane) => laneFiles(lane, deps, { signal: req.signal })));
  /* A reader revoked while Git ran gets nothing, as the gate would answer. */
  const scope = deps.scope(req);
  if (scope && lanes.some((lane) => !scope.canReadFile(lane.project))) return workspaceDenied();
  const body: { lanes: TaskFilesLane[]; omitted: number } = { lanes: answered, omitted };
  return NextResponse.json(body, { headers: { "cache-control": "private, no-store" } });
}

type ParsedContent = { lane: string; head: string; file: string; meta: boolean; download: boolean };

function parseContent(req: NextRequest): ParsedContent | Refusal {
  const params = req.nextUrl.searchParams;
  const lane = params.get("lane") ?? "";
  const head = params.get("head") ?? "";
  const file = params.get("file") ?? "";
  if (!ID_RE.test(lane)) return refuse(400, "invalid_request", "lane is invalid");
  if (!SHA_RE.test(head)) return refuse(400, "invalid_request", "head must be a full commit id");
  if (!file || file.length > FILE_MAX || file.includes("\0") || file.startsWith("/") || file.split("/").some((segment) => segment === "." || segment === "..")) {
    return refuse(400, "invalid_request", "file is not a repository-relative path");
  }
  return { lane, head, file, meta: params.get("mode") === "meta", download: params.get("download") === "1" };
}

/** GET /api/tasks/[id]/files/content — one committed blob, never a disk read. */
export async function taskFileContentGET(req: NextRequest, taskId: string, deps: TaskFilesDependencies): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection as Refusal;
  const parsed = parseContent(req);
  if ("status" in parsed) return parsed;
  if (!deps.task(taskId)) return refuse(404, "task_not_found", "task not found");
  const lane = admittedLane(req, taskId, parsed.lane, deps);
  if (lane === "forbidden") return workspaceDenied();
  if (!lane) return refuse(404, "lane_not_found", "lane not found");

  let resolved;
  try {
    resolved = await resolveFile(lane, parsed.head, parsed.file, deps, req.signal);
  } catch (error) {
    if (error instanceof Aborted) return refuse(499, "aborted", "the request was cancelled");
    return refuse(500, "git_failed", "git could not read the lane");
  }
  if ("status" in resolved) return failure(resolved);
  const etag = `"g${resolved.oid}"`;

  const tooLarge = resolved.size > PREVIEW_MAX_BYTES;
  if (!parsed.meta && tooLarge) return refuse(413, "too-large", "file exceeds the preview byte bound");
  const ifMatch = req.headers.get("if-match");
  if (!parsed.meta && ifMatch !== null && ifMatch !== etag) return refuse(412, "changed", "file changed since the preview opened");

  let bytes: Buffer | null = null;
  if (!tooLarge) {
    const realRepo = await fs.realpath(lane.repoDir).catch(() => null);
    if (!realRepo) return refuse(404, "not-found", "the lane's repository is not on this machine");
    const read = await readBlob(lane, realRepo, resolved, deps, req.signal);
    if ("status" in read) return failure(read);
    bytes = read;
    if (!sniffAgrees(resolved.mime, bytes.subarray(0, Math.min(SNIFF_BYTES, bytes.length)))) {
      return refuse(415, "mime-mismatch", "file content does not match its extension");
    }
  }

  if (parsed.meta) {
    const baseDir = await documentBaseDir(lane, parsed.file);
    return NextResponse.json(
      {
        name: resolved.name, kind: resolved.kind, mime: resolved.mime, size: resolved.size, mtimeMs: resolved.committedAt, etag,
        revision: { head: resolved.head, committedAt: resolved.committedAt, headSource: resolved.headSource },
        baseDir,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  const content = bytes!;
  const headers = artifactResponseHeaders(resolved.mime, etag, resolved.name, parsed.download);
  const range = parseByteRange(req.headers.get("range"), content.length);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${content.length}`);
    return new NextResponse(null, { status: 416, headers });
  }
  const window = range ?? { start: 0, end: content.length - 1 };
  const length = content.length === 0 ? 0 : window.end - window.start + 1;
  headers.set("content-length", String(Math.max(length, 0)));
  if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${content.length}`);
  if (length <= 0) return new NextResponse(null, { status: range ? 206 : 200, headers });
  /* A view, not a copy: the cached buffer is never written to. */
  const body = new Uint8Array(content.buffer as ArrayBuffer, content.byteOffset + window.start, length);
  return new NextResponse(body, { status: range ? 206 : 200, headers });
}
