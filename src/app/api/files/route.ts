import { createHash } from "node:crypto";
import fs from "node:fs";

import { agentRegistry } from "@/lib/agent/registry";
import { bridgeReportLogSignature } from "@/lib/bridge/store";
import { statePath } from "@/lib/configDir";
import { FILES_BUILT_HEADER, formatFilesBuilt, type FilesBuilt } from "@/lib/filesBuilt";
import { diffFilesBodies, FILES_DELTA_ACCEPT_HEADER, FILES_DELTA_BASE_HEADER } from "@/lib/filesDelta";
import { acceptsGzip, gzipBody } from "@/lib/http/gzipBody";
import { readStateCollectionRevision } from "@/lib/state/sqliteStateStore";
import { ensureEmptyTaskBoardVisibilityMigration } from "@/lib/tasks/boardVisibilityMigration";
import { buildFilesResponse } from "./response";
import { cachedFileScan } from "@/lib/scanner/scanCache";
import { buildFilesResponseInWorker, filesResponseWorkerEnabled } from "@/lib/scanner/filesResponseWorker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function generationHeader(request: Request, name: string): number | undefined {
  const value = request.headers.get(name);
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const generation = Number(value);
  return Number.isSafeInteger(generation) ? generation : undefined;
}

type CachedScan = Awaited<ReturnType<typeof cachedFileScan>>;
type ProjectionRepresentation = {
  body: string;
  contentType: string;
  etag: string;
  timing: string;
  delta?: { base: string; body: string };
  /** The state this body was built from, sent with it whenever it is served,
      a stale answer included (#2072). */
  built?: FilesBuilt;
};
type ProjectionResult = {
  representation: ProjectionRepresentation;
  cacheStatus: "hit" | "joined" | "miss" | "stale";
};
type CachedProjection = { key: string; representation: ProjectionRepresentation };
// v2: pre-#1718 full bodies lack lastAgentWorkAt even after a fresh scan.
// Invalidate them independently of the persisted scan's schema.
const PERSISTED_PROJECTION_VERSION = 2;
type PersistedProjection = {
  version: typeof PERSISTED_PROJECTION_VERSION;
  bodyFile: string;
  contentType: string;
  etag: string;
  timing: string;
};

const PROJECTION_CACHE_MAX = 32;
const PROJECTION_STALE_WAIT_MS = 100;
const PERSISTED_PROJECTION_META_FILE = "files-response-cache.json";
const PERSISTED_PROJECTION_BODY_PREFIX = "files-response-cache-";
const PERSISTED_PROJECTION_KEY_PREFIX = "persisted:";
const PROJECTION_STATE_FILES = [
  "project-aliases.json",
  "project-curation.json",
  "worktree-map.json",
  "reaper-state.json",
  /* A state database fallback or a refused backup (#1870 slice 10) shows in
     `systemHealth.storage` on the next poll, not after some other store moves. */
  "storage-incidents.json",
] as const;
/* A client more links behind than this, or whose deltas add up to more than a
   quarter of the full body, is sent the full body. */
const DELTA_LINKS_PER_SCOPE = 32;
const DELTA_PATH_MAX_LINKS = 16;
const DELTA_MAX_BODY_FRACTION = 0.25;
type DeltaLink = { etag: string; delta: string };
const projectionCacheStore = globalThis as typeof globalThis & {
  __llvFilesProjectionCache?: Map<string, CachedProjection>;
  __llvFilesDeltaLinks?: Map<string, Map<string, DeltaLink>>;
  __llvFilesGzipBodies?: WeakMap<ProjectionRepresentation, Promise<Uint8Array>>;
  __llvFilesProjectionInflight?: Map<string, Promise<ProjectionRepresentation>>;
  __llvFilesProjectionWorkerTail?: Promise<void>;
  __llvFilesProjectionPersistenceTail?: Promise<void>;
  __llvFilesPersistedProjectionChecked?: boolean;
  __llvFilesProjectionSequence?: number;
};

/** The next build in this process's order, taken when a build reads the
    stores: a later build read later stores. */
function nextProjectionSequence(): number {
  projectionCacheStore.__llvFilesProjectionSequence = (projectionCacheStore.__llvFilesProjectionSequence ?? 0) + 1;
  return projectionCacheStore.__llvFilesProjectionSequence;
}

function projectionCache(): Map<string, CachedProjection> {
  projectionCacheStore.__llvFilesProjectionCache ??= new Map();
  return projectionCacheStore.__llvFilesProjectionCache;
}

/* Every representation a scope moved through, as base ETag → the next one and
   the delta that gets there (#1994). A phone that certified any recent
   representation catches up with the rows that changed, never the board. */
function deltaLinks(scopeKey: string): Map<string, DeltaLink> {
  projectionCacheStore.__llvFilesDeltaLinks ??= new Map();
  let links = projectionCacheStore.__llvFilesDeltaLinks.get(scopeKey);
  if (!links) {
    links = new Map();
    projectionCacheStore.__llvFilesDeltaLinks.set(scopeKey, links);
  }
  return links;
}

function recordDeltaLink(scopeKey: string, base: string, etag: string, delta: string): void {
  if (!base || !etag || base === etag) return;
  const links = deltaLinks(scopeKey);
  links.delete(base);
  links.set(base, { etag, delta });
  while (links.size > DELTA_LINKS_PER_SCOPE) {
    const oldest = links.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    links.delete(oldest);
  }
}

/** The deltas from `from` to `to`, or null when the chain does not reach or a
    full body is cheaper. */
function deltaPath(scopeKey: string, from: string, to: string, fullBytes: number): string[] | null {
  const links = projectionCacheStore.__llvFilesDeltaLinks?.get(scopeKey);
  if (!links) return null;
  const deltas: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let at = from;
  while (at !== to) {
    const link = links.get(at);
    if (!link || seen.has(at) || deltas.length >= DELTA_PATH_MAX_LINKS) return null;
    seen.add(at);
    bytes += link.delta.length;
    if (bytes > fullBytes * DELTA_MAX_BODY_FRACTION) return null;
    deltas.push(link.delta);
    at = link.etag;
  }
  return deltas.length ? deltas : null;
}

/** One compression per representation, however many clients fetch it. */
function gzippedRepresentation(representation: ProjectionRepresentation): Promise<Uint8Array> {
  projectionCacheStore.__llvFilesGzipBodies ??= new WeakMap();
  let compressed = projectionCacheStore.__llvFilesGzipBodies.get(representation);
  if (!compressed) {
    compressed = gzipBody(representation.body);
    projectionCacheStore.__llvFilesGzipBodies.set(representation, compressed);
    void compressed.catch(() => projectionCacheStore.__llvFilesGzipBodies?.delete(representation));
  }
  return compressed;
}

function projectionInflight(): Map<string, Promise<ProjectionRepresentation>> {
  projectionCacheStore.__llvFilesProjectionInflight ??= new Map();
  return projectionCacheStore.__llvFilesProjectionInflight;
}

function stateFileSignature(filename: string): string {
  const pathname = statePath(filename);
  try {
    const stat = fs.statSync(pathname);
    return `${pathname}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${pathname}:missing`;
  }
}

function hotStateSignature(collection: string, legacyFilename: string): string {
  const revision = readStateCollectionRevision(statePath("state.sqlite"), collection);
  return revision === null ? stateFileSignature(legacyFilename) : `${collection}:sqlite:${revision}`;
}

function projectionBaseKey(
  scan: CachedScan,
  pinnedPath: string | undefined,
): string {
  return createHash("sha1").update(JSON.stringify({
    pinnedPath: pinnedPath ?? null,
    /* `generation` is the immutable identity of the published snapshot.
       Re-stringifying every file row on every poll burns the request thread
       precisely while a new scan is being published. */
    generation: scan.generation,
    pinOverlayPaths: scan.pinOverlayPaths ?? [],
    stores: [
      ...PROJECTION_STATE_FILES.map(stateFileSignature),
      hotStateSignature("tasks", "tasks.json"),
      hotStateSignature("flows", "flows.json"),
      hotStateSignature("pipelines", "pipelines.json"),
      hotStateSignature("workflows", "workflows.json"),
      /* A needs-you dismissal (or its undo) moves no scan and no other store,
         and the projection carries it onto its conversation's entries. */
      hotStateSignature("attention_dismissals", "attention-dismissals.json"),
      /* The orchestrator's open ask is derived from the bridge report log (issue
         #1168), so a report filed — or answered — between two identical scans
         has to invalidate the projection. Without it the ask would appear, and
         clear, only when some unrelated store happened to move. */
      bridgeReportLogSignature(),
    ],
  })).digest("hex");
}

function projectionScopeKey(
  pinnedPath: string | undefined,
  summary = false,
): string {
  return JSON.stringify(summary ? [pinnedPath ?? null, "summary"] : [pinnedPath ?? null]);
}

function projectionKey(baseKey: string): string {
  const registryDiagnostics = agentRegistry().storageDiagnostics();
  return `${baseKey}:${registryDiagnostics.revision ?? "json"}:${registryDiagnostics.transactionCount}`;
}

function queueProjectionWorker(
  build: () => Promise<ProjectionRepresentation>,
): Promise<ProjectionRepresentation> {
  const previous = projectionCacheStore.__llvFilesProjectionWorkerTail ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(build);
  projectionCacheStore.__llvFilesProjectionWorkerTail = current.then(() => undefined, () => undefined);
  return current;
}

async function projectionWithinBudget(
  promise: Promise<ProjectionRepresentation>,
  waitMs = PROJECTION_STALE_WAIT_MS,
): Promise<ProjectionRepresentation | undefined> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function rememberProjection(scopeKey: string, key: string, representation: ProjectionRepresentation): void {
  const cache = projectionCache();
  cache.delete(scopeKey);
  cache.set(scopeKey, { key, representation });
  while (cache.size > PROJECTION_CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function validPersistedProjection(value: unknown): value is PersistedProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === PERSISTED_PROJECTION_VERSION
    && typeof candidate.bodyFile === "string"
    && new RegExp(`^${PERSISTED_PROJECTION_BODY_PREFIX}[0-9a-f]{40}\\.json$`).test(candidate.bodyFile)
    && typeof candidate.contentType === "string"
    && typeof candidate.etag === "string"
    && /^"[0-9a-f]{40}"$/.test(candidate.etag)
    && typeof candidate.timing === "string";
}

function warmPersistedProjection(scopeKey: string, pinnedPath: string | undefined, epoch: string): void {
  if (pinnedPath || projectionCacheStore.__llvFilesPersistedProjectionChecked) return;
  projectionCacheStore.__llvFilesPersistedProjectionChecked = true;
  try {
    const metadata = JSON.parse(fs.readFileSync(statePath(PERSISTED_PROJECTION_META_FILE), "utf8")) as unknown;
    if (!validPersistedProjection(metadata)) return;
    const body = fs.readFileSync(statePath(metadata.bodyFile), "utf8");
    const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
    if (etag !== metadata.etag) return;
    rememberProjection(scopeKey, `${PERSISTED_PROJECTION_KEY_PREFIX}${etag}`, {
      body,
      contentType: metadata.contentType,
      etag,
      timing: metadata.timing,
      /* Built by an earlier process, so before anything this one builds. */
      built: { epoch, generation: 0, sequence: 0 },
    });
  } catch {
    // A first run or interrupted cache write performs one live projection.
  }
}

async function persistProjection(representation: ProjectionRepresentation): Promise<void> {
  const digest = representation.etag.slice(1, -1);
  if (!/^[0-9a-f]{40}$/.test(digest)) return;
  const directory = statePath(".");
  const bodyFile = `${PERSISTED_PROJECTION_BODY_PREFIX}${digest}.json`;
  const bodyPath = statePath(bodyFile);
  const metaPath = statePath(PERSISTED_PROJECTION_META_FILE);
  const nonce = `${process.pid}-${Date.now()}`;
  const bodyTemporary = `${bodyPath}.${nonce}.tmp`;
  const metaTemporary = `${metaPath}.${nonce}.tmp`;
  let previousBodyFile: string | undefined;
  try {
    const previous = JSON.parse(await fs.promises.readFile(metaPath, "utf8")) as unknown;
    if (validPersistedProjection(previous)) previousBodyFile = previous.bodyFile;
  } catch {
    // The first completed projection has no predecessor.
  }
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(bodyTemporary, representation.body, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(bodyTemporary, bodyPath);
  const metadata: PersistedProjection = {
    version: PERSISTED_PROJECTION_VERSION,
    bodyFile,
    contentType: representation.contentType,
    etag: representation.etag,
    timing: representation.timing,
  };
  await fs.promises.writeFile(metaTemporary, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(metaTemporary, metaPath);
  if (previousBodyFile && previousBodyFile !== bodyFile) {
    await fs.promises.rm(statePath(previousBodyFile), { force: true });
  }
}

function schedulePersistProjection(representation: ProjectionRepresentation): void {
  if (process.env.NODE_ENV === "test" && process.env.LLV_FILES_PROJECTION_PERSIST_FOR_TEST !== "1") return;
  const previous = projectionCacheStore.__llvFilesProjectionPersistenceTail ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => persistProjection(representation));
  projectionCacheStore.__llvFilesProjectionPersistenceTail = current;
  void current.catch((error) => {
    console.error("[files projection cache] persistence failed", error);
  });
}

async function projectionFor(
  scopeKey: string,
  key: string,
  request: Request,
  scan: CachedScan,
  summary: boolean,
): Promise<ProjectionResult> {
  const cached = projectionCache().get(scopeKey);
  if (cached?.key === key) return { representation: cached.representation, cacheStatus: "hit" };

  const current = projectionInflight().get(scopeKey);
  if (current) {
    if (cached) {
      return { representation: cached.representation, cacheStatus: "stale" };
    }
    return { representation: await current, cacheStatus: "joined" };
  }

  const promise = (async () => {
    const headers = new Headers(request.headers);
    headers.delete("if-none-match");
    const previous = cached?.representation;
    const snapshot = { ...scan.snapshot, pinOverlayPaths: scan.pinOverlayPaths };
    const persistedSnapshot = statePath("files-scan-snapshot.json");
    const epoch = scan.epoch ?? "0";
    let representation: ProjectionRepresentation;
    if (filesResponseWorkerEnabled()) {
      representation = await queueProjectionWorker(async () => {
        /* The build order is taken as the build starts, where it reads the
           stores. The persisted snapshot is read by the worker when its turn
           comes, and a later scan may have replaced it by then: the file
           names its own generation and the worker reports it back, so the
           rows are dated by the scan they came from. A file this process
           never wrote holds the snapshot it warm-started from, which it
           counts as generation 0. */
        const sequence = nextProjectionSequence();
        const fromFile = !scan.pinOverlayPaths?.length && fs.existsSync(persistedSnapshot);
        const { snapshotRead, ...projected } = await buildFilesResponseInWorker({
          type: "project",
          url: request.url,
          headers: [...headers.entries()],
          ...(fromFile ? { snapshotFile: persistedSnapshot } : { snapshot }),
          ...(summary ? { deltaScope: createHash("sha1").update(scopeKey).digest("hex") } : {}),
        });
        const generation = !fromFile ? scan.generation : snapshotRead?.epoch === epoch ? snapshotRead.generation : 0;
        return { ...projected, built: { epoch, generation, sequence } };
      });
    } else {
      /* Stamped as the build starts, where it reads the stores. */
      const built: FilesBuilt = { epoch, generation: scan.generation, sequence: nextProjectionSequence() };
      const response = await buildFilesResponse(new Request(request.url, { headers }), {
        listFilesWithProjectCatalog: async () => snapshot,
      });
      representation = {
        body: await response.text(),
        contentType: response.headers.get("content-type") ?? "application/json",
        etag: response.headers.get("etag") ?? "",
        timing: response.headers.get("server-timing") ?? "",
        built,
      };
      if (summary && previous && previous.etag !== representation.etag) {
        representation.delta = {
          base: previous.etag,
          body: diffFilesBodies(previous.body, representation.body, previous.etag, representation.etag),
        };
      }
    }
    if (representation.delta) {
      recordDeltaLink(scopeKey, representation.delta.base, representation.etag, representation.delta.body);
      /* The link holds the delta; the cached representation need not. */
      representation = { ...representation, delta: undefined };
    }
    rememberProjection(scopeKey, key, representation);
    if (scopeKey === projectionScopeKey(undefined)) {
      schedulePersistProjection(representation);
    }
    return representation;
  })();
  projectionInflight().set(scopeKey, promise);
  void promise.catch(() => undefined).finally(() => {
    if (projectionInflight().get(scopeKey) === promise) projectionInflight().delete(scopeKey);
  });
  if (cached && (
    request.headers.has("if-none-match")
    || cached.key.startsWith(PERSISTED_PROJECTION_KEY_PREFIX)
  )) {
    return { representation: cached.representation, cacheStatus: "stale" };
  }
  if (cached) {
    const completed = await projectionWithinBudget(promise);
    return completed
      ? { representation: completed, cacheStatus: "miss" }
      : { representation: cached.representation, cacheStatus: "stale" };
  }
  try {
    return { representation: await promise, cacheStatus: "miss" };
  } finally {
    if (projectionInflight().get(scopeKey) === promise) projectionInflight().delete(scopeKey);
  }
}

function applyScanHeaders(response: Response, scan: CachedScan, projectionTiming?: string | null): void {
  response.headers.set("x-llv-files-generation", String(scan.generation));
  response.headers.set("x-llv-files-target-generation", String(scan.targetGeneration));
  response.headers.set("x-llv-files-cache", scan.cacheStatus);
  response.headers.set("x-llv-files-cache-requests", String(scan.requestCount));
  const serverTiming = [`files-clone;dur=${scan.cloneDurationMs.toFixed(1)}`];
  if (scan.lastScan) {
    const failure = scan.lastScan.status === "failed" ? " failed" : "";
    serverTiming.push(`files-scan;dur=${scan.lastScan.durationMs.toFixed(1)};desc="${scan.lastScan.reason} generation ${scan.lastScan.generation}${failure}"`);
  }
  if (projectionTiming) serverTiming.push(projectionTiming);
  response.headers.set("server-timing", serverTiming.join(", "));
}

export async function GET(request: Request): Promise<Response> {
  const requiredRevision = generationHeader(request, "x-llv-files-revision");
  const requiredGeneration = generationHeader(request, "x-llv-files-generation");
  const url = new URL(request.url);
  const selectedProject = url.searchParams.get("project")?.trim() || undefined;
  const pinnedPath = url.searchParams.get("path")?.trim() || undefined;
  const scan = await cachedFileScan(
    selectedProject,
    pinnedPath,
    Date.now(),
    requiredRevision,
    requiredGeneration,
  );

  /* One-time, in the long-lived server process rather than in the per-request
     response worker: the guard there would be re-armed on every spawn, and the
     board must not pay a task-file transaction per poll. It runs here, after
     the scan and before the projection that reads the tasks, because what it
     decides is membership — which task still holds a conversation THIS BOARD
     carries — and only the scan can answer that. A partial scan is not an
     answer: it would report a conversation as gone because it had not been
     reached yet, so an incomplete one defers to the next request. */
  if (scan.snapshot.complete) ensureEmptyTaskBoardVisibilityMigration(scan.snapshot.files);

  /* Completion retries already hold the last successful representation. While
     its requested scan is still running, rebuilding the multi-store projection
     only delays that scan and can form a self-sustaining retry storm. */
  const previousEtag = request.headers.get("if-none-match");
  if (requiredGeneration !== undefined && scan.generation < scan.targetGeneration && previousEtag) {
    const response = new Response(null, {
      status: 304,
      headers: {
        ETag: previousEtag,
        "server-timing": `files-generation-wait;dur=0.0;desc="generation ${scan.generation} of ${scan.targetGeneration}"`,
      },
    });
    applyScanHeaders(response, scan, response.headers.get("server-timing"));
    return response;
  }

  const baseKey = projectionBaseKey(scan, pinnedPath);
  const key = projectionKey(baseKey);
  const summary = url.searchParams.get("view") === "summary";
  const scopeKey = projectionScopeKey(pinnedPath, summary);
  if (!summary) warmPersistedProjection(scopeKey, pinnedPath, scan.epoch ?? "0");
  const projected = await projectionFor(scopeKey, key, request, scan, summary);
  const notModified = request.headers.get("if-none-match") === projected.representation.etag;
  const projectionTiming = [
    projected.representation.timing,
    `files-projection-cache;dur=0.0;desc="${projected.cacheStatus}"`,
  ].filter(Boolean).join(", ");
  const headers: Record<string, string> = {
    ETag: projected.representation.etag,
    ...(notModified ? {} : { "content-type": projected.representation.contentType }),
    "x-llv-files-projection-cache": projected.cacheStatus,
    vary: `accept-encoding, ${FILES_DELTA_ACCEPT_HEADER}`,
    /* The live scan's generation goes out as `x-llv-files-generation`; this
       is the one the body was built from, older when the answer is stale. */
    ...(projected.representation.built ? { [FILES_BUILT_HEADER]: formatFilesBuilt(projected.representation.built) } : {}),
  };
  let body: string | Uint8Array | null = null;
  if (!notModified) {
    /* A client that certified an earlier representation of this scope, and
       says it can apply a delta, gets the rows that changed since (#1994). */
    const base = request.headers.get("if-none-match");
    const deltas = base && summary && request.headers.get(FILES_DELTA_ACCEPT_HEADER) === "1"
      ? deltaPath(scopeKey, base, projected.representation.etag, projected.representation.body.length)
      : null;
    if (deltas && base) {
      headers[FILES_DELTA_BASE_HEADER] = base;
      headers["cache-control"] = "no-store";
      body = `{"deltas":[${deltas.join(",")}]}`;
    } else {
      body = projected.representation.body;
    }
    if (acceptsGzip(request) && body.length >= 1024) {
      body = deltas ? await gzipBody(body) : await gzippedRepresentation(projected.representation);
      headers["content-encoding"] = "gzip";
    }
  }
  const response = new Response(body as BodyInit | null, {
    status: notModified ? 304 : 200,
    headers,
  });
  applyScanHeaders(response, scan, projectionTiming);
  return response;
}
