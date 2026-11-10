import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { classifyArtifact, type ArtifactKind } from "@/lib/artifact/classify";
import { LANE_CHANGE_LIMITS, laneChangeFiles, resolveLaneRevisions, type LaneChangeError, type LaneChangeFile, type LaneChangeOp, type LaneRevisions } from "@/lib/pipelines/laneChanges";
import type { Pipeline } from "@/lib/pipelines/types";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import type { ExecOptions, ExecPort } from "@/lib/workflows/provision";
import { Aborted, QueueFull, type TaskFilesCaches } from "./cache";
import { PREVIEW_MAX_BYTES } from "./limits";

/* A task's files: what each of its lanes committed, read from Git at a pinned
   commit (docs/design/task-file-preview.md §5, §6). The commit is the
   manifest, so nothing here touches a worktree, runs `git status`, scans a
   filesystem or reads content for a list. Every revision is resolved again on
   every request; only facts about an immutable commit pair are cached. */

export { PREVIEW_MAX_BYTES };
const GIT_OPTIONS: ExecOptions = { timeoutMs: 10_000 };
const SHA_RE = /^[0-9a-f]{40}$/;
const OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export type TaskFileGroup = "declared" | "document" | "image" | "source" | "other";
export type TaskFileMode = "file" | "link" | "submodule";

export type TaskFile = {
  path: string;
  op: LaneChangeOp;
  added: number;
  removed: number;
  binary: boolean;
  mode: TaskFileMode | null;
  size: number | null;
  group: TaskFileGroup;
  previewable: boolean;
  declaredBy?: string;
};

export type TaskFilesLane =
  | {
      lane: string; status: "ok"; head: string; base: string; headSource: "branch" | "last-passed";
      committedAt: number; files: TaskFile[]; total: number; truncated: boolean;
    }
  | { lane: string; status: "unavailable"; reason: "repository-missing" | "commits-gone" | "failed" | "busy" };

export type TaskFilesDeps = { exec: ExecPort; caches: TaskFilesCaches };

type LanePipeline = Pick<Pipeline, "id" | "repoDir" | "worktreeDir" | "branch" | "baseBranch" | "baseRef" | "lastPassedCommit" | "stages">;

/** What a pair's list cache holds: the full change membership, and the shown rows. */
type PairList = { committedAt: number; membership: Map<string, LaneChangeOp>; files: TaskFile[]; total: number };

const DOCUMENT_EXTENSIONS = new Set(["md", "markdown", "txt", "pdf", "html", "htm", "csv", "tsv", "json", "yaml", "yml", "toml", "log"]);
const GROUP_RANK: Record<TaskFileGroup, number> = { declared: 0, document: 1, image: 2, source: 3, other: 4 };

const extensionOf = (file: string): string => {
  const base = file.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};
const isMarkdown = (file: string): boolean => /^(md|markdown)$/.test(extensionOf(file));

function groupOf(file: string, declared: boolean): TaskFileGroup {
  if (declared) return "declared";
  const kind = classifyArtifact(file)?.kind;
  if (kind === "image") return "image";
  if (DOCUMENT_EXTENSIONS.has(extensionOf(file)) && kind) return "document";
  return kind ? "source" : "other";
}

const normalizeOutput = (output: string): string => output.trim().replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");

/** The stage that declared this path as an output, or one of its directories. */
function declaredBy(lane: LanePipeline, file: string): string | undefined {
  for (const stage of lane.stages ?? []) {
    for (const raw of stage.outputs ?? []) {
      const output = normalizeOutput(raw);
      if (output && (file === output || file.startsWith(`${output}/`))) return stage.id;
    }
  }
  return undefined;
}

export type TreeRecord = { mode: string; type: string; oid: string; size: number | null; path: string };

/** `git ls-tree -z -l` records: `<mode> <type> <oid> <size>\t<path>\0`. */
export function parseTree(stdout: string): TreeRecord[] | null {
  if (stdout && !stdout.endsWith("\0")) return null;
  const records: TreeRecord[] = [];
  for (const record of stdout ? stdout.split("\0").slice(0, -1) : []) {
    const match = record.match(/^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t([\s\S]*)$/);
    if (!match) return null;
    records.push({ mode: match[1], type: match[2], oid: match[3], size: match[4] === "-" ? null : Number(match[4]), path: match[5] });
  }
  return records;
}

export function modeOf(record: Pick<TreeRecord, "mode" | "type">): TaskFileMode | null {
  if (record.type === "blob" && (record.mode === "100644" || record.mode === "100755")) return "file";
  if (record.type === "blob" && record.mode === "120000") return "link";
  if (record.type === "commit" && record.mode === "160000") return "submodule";
  return null;
}

async function lsTree(lane: LanePipeline, head: string, paths: readonly string[], deps: TaskFilesDeps): Promise<TreeRecord[] | null> {
  if (!paths.length) return [];
  const result = await deps.exec("git", ["--literal-pathspecs", "ls-tree", "-z", "-l", head, "--", ...paths], lane.repoDir, undefined, { ...GIT_OPTIONS, stdoutEncoding: "latin1" });
  if (result.code !== 0) return null;
  /* latin1 kept the path bytes whole; decode them as the UTF-8 they are. */
  const records = parseTree(result.stdout);
  return records?.map((record) => ({ ...record, path: Buffer.from(record.path, "latin1").toString("utf8") })) ?? null;
}

function buildRows(lane: LanePipeline, changes: readonly LaneChangeFile[], tree: ReadonlyMap<string, TreeRecord>): TaskFile[] {
  return changes.map((change) => {
    const record = change.op === "delete" ? null : tree.get(change.path) ?? null;
    const by = change.op === "delete" ? undefined : declaredBy(lane, change.path);
    const mode = record ? modeOf(record) : null;
    const size = record?.size ?? null;
    const classified = classifyArtifact(change.path);
    return {
      path: change.path, op: change.op, added: change.added, removed: change.removed, binary: change.binary,
      mode, size, group: groupOf(change.path, by !== undefined),
      previewable: Boolean(classified) && !(change.binary && classified?.kind === "text") && change.op !== "delete" && mode === "file" && size !== null && size <= PREVIEW_MAX_BYTES,
      ...(by ? { declaredBy: by } : {}),
    };
  });
}

/** Declared outputs, then documents (Markdown first), images, source, other;
    deletions last. Truncation happens after this order. */
export function sortRows<T extends Pick<TaskFile, "path" | "op" | "group">>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const deleted = Number(a.op === "delete") - Number(b.op === "delete");
    if (deleted) return deleted;
    if (a.group !== b.group) return GROUP_RANK[a.group] - GROUP_RANK[b.group];
    if (a.group === "document" || a.group === "declared") {
      const md = Number(isMarkdown(b.path)) - Number(isMarkdown(a.path));
      if (md) return md;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/** The part of a lane that shapes the shown rows without being a Git fact: the
    outputs its stages declare, in order. Two lanes (or one lane whose
    declarations changed) with the same commit pair never share rows. */
function declarationsKey(lane: LanePipeline): string {
  const declared = (lane.stages ?? []).map((stage) => [stage.id, (stage.outputs ?? []).map(normalizeOutput)]);
  return createHash("sha1").update(JSON.stringify(declared)).digest("hex");
}

function pairKey(lane: LanePipeline, realRepo: string, base: string, head: string): string {
  return `${realRepo}\0${base}\0${head}\0${declarationsKey(lane)}`;
}

function listBytes(list: PairList): number {
  let bytes = 256;
  for (const [file] of list.membership) bytes += file.length * 2 + 24;
  for (const row of list.files) bytes += 160 + row.path.length * 2 + (row.declaredBy?.length ?? 0) * 2;
  return bytes;
}

async function commitTime(lane: LanePipeline, head: string, deps: TaskFilesDeps): Promise<number> {
  const result = await deps.exec("git", ["show", "-s", "--format=%ct", head], lane.repoDir, undefined, GIT_OPTIONS);
  const seconds = Number(result.stdout.trim());
  return result.code === 0 && Number.isFinite(seconds) ? seconds * 1000 : 0;
}

export type PairResult = { list: PairList } | { failed: true };

/** An exec port whose children end when the signal aborts, so work nobody
    waits for stops spawning and the slot it holds frees at once. */
function boundTo(exec: ExecPort, signal: AbortSignal): ExecPort {
  return (command, args, cwd, env, options) => exec(command, args, cwd, env, { ...options, signal: options?.signal ? AbortSignal.any([options.signal, signal]) : signal });
}

const checkpoint = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Aborted();
};

/** The change list of one commit pair, from the cache or from Git. The caller
    holds an admission slot for the whole call and passes an exec bound to the
    signal; a result is cached only while that signal is still live. */
export async function pairList(lane: LanePipeline, realRepo: string, base: string, head: string, deps: TaskFilesDeps, signal: AbortSignal): Promise<PairResult> {
  const key = pairKey(lane, realRepo, base, head);
  const cached = deps.caches.lists.get(key) as PairList | undefined;
  if (cached) return { list: cached };
  const changes = await laneChangeFiles(lane, base, head, deps.exec);
  checkpoint(signal);
  if (!changes) return { failed: true };
  const membership = new Map<string, LaneChangeOp>(changes.map((change) => [change.path, change.op]));
  /* The tree is read only for the rows that will show, after the sort. */
  const provisional = sortRows(buildRows(lane, changes, new Map()));
  const shown = provisional.slice(0, LANE_CHANGE_LIMITS.files);
  const byPath = new Map(changes.map((change) => [change.path, change]));
  const tree = await lsTree(lane, head, shown.filter((row) => row.op !== "delete").map((row) => row.path), deps);
  checkpoint(signal);
  if (!tree) return { failed: true };
  const files = buildRows(lane, shown.map((row) => byPath.get(row.path)!), new Map(tree.map((record) => [record.path, record])));
  const committedAt = await commitTime(lane, head, deps);
  checkpoint(signal);
  const list: PairList = { committedAt, membership, files, total: changes.length };
  deps.caches.lists.set(key, list, listBytes(list));
  return { list };
}

const isAbort = (error: unknown): boolean => error instanceof Aborted;

/** A task's revisions: the lane's pair plus the commit the lane was created
    from when that commit is part of the lane's own history. */
export type TaskRevisions = LaneRevisions & { taskBase: string | null };

/** The commits a task's files are read between. Head is the lane's tip (its
    branch, else the last passed commit). The base is the merge base with the
    fetched base branch, unless the commit the lane was created from
    (`baseRef`) is a descendant of it. That covers a base branch that lags the
    lane's start, and a lane that landed (the merge base is then the head
    itself), so the files stay listed after the branch is swept and
    `origin/<base>` moves on. A base the lane was created from must be an
    ancestor of the head, or the pair would not be the task's own interval. */
export async function taskRevisions(lane: LanePipeline, exec: ExecPort): Promise<TaskRevisions | LaneChangeError> {
  const resolved = await resolveLaneRevisions(lane, exec);
  if ("error" in resolved) return resolved;
  const busy: LaneChangeError = { error: "git did not answer in time", code: "git_failed" };
  let created: string | null = null;
  if (lane.baseRef) {
    if (lane.baseRef === resolved.base || resolved.baseSource === "base-ref") created = resolved.base;
    else {
      const answer = await exec("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${lane.baseRef}^{commit}`], lane.repoDir, undefined, GIT_OPTIONS);
      const sha = answer.stdout.trim();
      if (answer.code === 0 && SHA_RE.test(sha)) created = sha;
    }
  }
  let taskBase: string | null = null;
  if (created) {
    const known = created === resolved.head || (resolved.baseSource === "merge-base" && created === resolved.base);
    const within = known ? true : await isAncestor(lane, created, resolved.head, exec);
    if (within === "failed") return busy;
    if (within) taskBase = created;
    else if (resolved.baseSource === "base-ref" ? resolved.base !== resolved.head : resolved.base === resolved.head) {
      /* The only base on offer (no fetched base branch, or a lane that landed) must be in the lane's history. */
      return { error: "the lane's base is not part of its history", code: "base_unavailable" };
    }
  }
  let revisions: LaneRevisions = resolved;
  if (taskBase && taskBase !== resolved.base) {
    /* Both are ancestors of the head; the later one starts the task's interval,
       so a base branch that lags the lane's start never widens it. */
    const later = resolved.base === resolved.head ? true : await isAncestor(lane, resolved.base, taskBase, exec);
    if (later === "failed") return busy;
    if (later) revisions = { ...resolved, base: taskBase, baseSource: "base-ref" };
  }
  return { ...revisions, taskBase };
}

/** One lane's answer. A deadline, a full line or a failure never throws. The
    lane's work runs once for every identical caller and holds its admission
    slot until its own Git work has ended: a deadline or a cancelled request
    kills the children, and the next caller gets the slot after they close, so
    cancelled requests never let more work run than the line allows. */
export async function laneFiles(lane: LanePipeline, deps: TaskFilesDeps, options: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<TaskFilesLane> {
  const unavailable = (reason: Extract<TaskFilesLane, { status: "unavailable" }>["reason"]): TaskFilesLane => ({ lane: lane.id, status: "unavailable", reason });
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.deadlineMs ?? 8_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try {
    return await (deps.caches.listFlights.join(laneKey(lane), signal, async (flight) => {
      const release = await deps.caches.listGate.acquire(flight);
      try {
        return await withViewerOperation("pipelines.laneChanges", () => laneJob(lane, { ...deps, exec: boundTo(deps.exec, flight) }, flight));
      } finally {
        release();
      }
    }) as Promise<TaskFilesLane>);
  } catch (error) {
    if (error instanceof QueueFull || isAbort(error)) return unavailable("busy");
    return unavailable("failed");
  } finally {
    clearTimeout(timer);
  }
}

function laneKey(lane: LanePipeline): string {
  return [lane.id, lane.repoDir, lane.branch, lane.lastPassedCommit, lane.baseRef, lane.baseBranch, declarationsKey(lane)].join("\0");
}

async function laneJob(lane: LanePipeline, deps: TaskFilesDeps, signal: AbortSignal): Promise<TaskFilesLane> {
  const unavailable = (reason: Extract<TaskFilesLane, { status: "unavailable" }>["reason"]): TaskFilesLane => ({ lane: lane.id, status: "unavailable", reason });
  let realRepo: string;
  try { realRepo = await fs.realpath(lane.repoDir); } catch { return unavailable("repository-missing"); }
  const revisions = await taskRevisions(lane, deps.exec);
  checkpoint(signal);
  if ("error" in revisions) return unavailable(revisions.code === "git_failed" ? "failed" : "commits-gone");
  const result = await pairList(lane, realRepo, revisions.base, revisions.head, deps, signal);
  if ("failed" in result) return unavailable("failed");
  const { list } = result;
  return {
    lane: lane.id, status: "ok", head: revisions.head, base: revisions.base, headSource: revisions.headSource,
    committedAt: list.committedAt, files: list.files, total: list.total, truncated: list.total > list.files.length,
  };
}

export type FileFailure = { status: number; code: string; error: string; retryAfter?: number };

export type ResolvedFile = {
  base: string;
  head: string;
  oid: string;
  size: number;
  kind: ArtifactKind;
  mime: string;
  name: string;
  committedAt: number;
  headSource: LaneRevisions["headSource"];
};

const fail = (status: number, code: string, error: string, retryAfter?: number): FileFailure => ({ status, code, error, ...(retryAfter ? { retryAfter } : {}) });

async function isAncestor(lane: LanePipeline, head: string, of: string, exec: ExecPort): Promise<boolean | "failed"> {
  const result = await exec("git", ["merge-base", "--is-ancestor", head, of], lane.repoDir, undefined, GIT_OPTIONS);
  if (result.code === 0) return true;
  /* 1: not an ancestor; 128: git does not know the object. */
  if (result.code === 1 || result.code === 128) return false;
  return "failed";
}

/** Checks 5 to 9 of the content route (§6.3): the requested head belongs to
    the lane, the pair lists the file, and the object at that commit is a plain
    blob of a previewable type. A warm answer is reused for 60 seconds. */
export async function resolveFile(lane: LanePipeline, head: string, file: string, deps: TaskFilesDeps, signal?: AbortSignal): Promise<ResolvedFile | FileFailure> {
  let realRepo: string;
  try { realRepo = await fs.realpath(lane.repoDir); } catch { return fail(404, "not-found", "the lane's repository is not on this machine"); }
  const key = `${lane.id}\0${realRepo}\0${head}\0${file}`;
  const warm = deps.caches.resolved.get(key) as ResolvedFile | undefined;
  if (warm) return warm;

  /* Concurrent identical opens share one resolution, so a stampede on one
     file (a viewer firing several ranges, or a repeated bad request) costs one
     round of Git calls. Only a success is kept afterwards. */
  return deps.caches.resolveFlights.join(key, signal, async (flight) => {
    let release: (() => void) | null = null;
    try {
      release = await deps.caches.listGate.acquire(flight);
    } catch (error) {
      if (error instanceof QueueFull) return fail(503, "busy", "still reading this lane", 2);
      throw error;
    }
    try {
      /* The slot frees when the Git work has ended; a resolution nobody waits for kills its children. */
      return await resolveUncached(lane, head, file, realRepo, key, { ...deps, exec: boundTo(deps.exec, flight) }, flight);
    } finally {
      release();
    }
  }) as Promise<ResolvedFile | FileFailure>;
}

async function resolveUncached(lane: LanePipeline, head: string, file: string, realRepo: string, key: string, deps: TaskFilesDeps, signal: AbortSignal): Promise<ResolvedFile | FileFailure> {
  const current = await taskRevisions(lane, deps.exec);
  if ("error" in current) return current.code === "git_failed" ? fail(503, "busy", "git did not answer in time", 2) : fail(409, "head_unknown", "the lane has no commit to read from");
  let revisions: LaneRevisions = current;
  if (head !== current.head) {
    /* An earlier head stays readable while it is an ancestor of the lane's tip
       and the task's own base is an ancestor of it: a commit from before the
       task started is no task output, whatever it shares with the tip. */
    const pinned = await taskRevisions({ ...lane, branch: "", lastPassedCommit: head }, deps.exec);
    if ("error" in pinned && pinned.code === "git_failed") return fail(503, "busy", "git did not answer in time", 2);
    if ("error" in pinned || pinned.head !== head) return fail(409, "head_unknown", "this commit is not known to the lane");
    const ancestor = await isAncestor(lane, head, current.head, deps.exec);
    if (ancestor === "failed") return fail(503, "busy", "git did not answer in time", 2);
    if (!ancestor) return fail(409, "head_unknown", "this commit is not part of the lane's history");
    if (current.taskBase && current.taskBase !== head) {
      /* The remote's base branch may lag the lane's start, so its merge base
         proves nothing about where the task began. */
      const afterBase = await isAncestor(lane, current.taskBase, head, deps.exec);
      if (afterBase === "failed") return fail(503, "busy", "git did not answer in time", 2);
      if (!afterBase) return fail(409, "head_unknown", "this commit is from before the task's base");
    }
    revisions = { ...pinned, headSource: current.headSource };
  }
  const result = await pairList(lane, realRepo, revisions.base, revisions.head, deps, signal);
  if ("failed" in result) return fail(500, "git_failed", "git could not list the lane's changes");
  const op = result.list.membership.get(file);
  if (!op) return fail(404, "not-listed", "this lane did not change that file");
  if (op === "delete") return fail(404, "not-found", "the lane deleted that file");

  const tree = await lsTree(lane, revisions.head, [file], deps);
  if (!tree) return fail(500, "git_failed", "git could not read the file's object");
  const record = tree.length === 1 && tree[0].path === file ? tree[0] : null;
  if (!record) return fail(404, "not-found", "the file is not in that commit");
  const mode = modeOf(record);
  if (mode === "link") return fail(403, "symlink", "a symbolic link is never followed");
  if (mode !== "file") return fail(415, "unsupported", "not a regular file");
  if (!OID_RE.test(record.oid) || record.size === null) return fail(500, "git_failed", "git returned an unusable object id");
  const classified = classifyArtifact(file);
  if (!classified) return fail(415, "unsupported", "not a previewable artifact type");

  const resolved: ResolvedFile = {
    base: revisions.base, head: revisions.head, oid: record.oid, size: record.size, kind: classified.kind, mime: classified.mime,
    name: file.split("/").pop() || file, committedAt: result.list.committedAt, headSource: revisions.headSource,
  };
  checkpoint(signal);
  deps.caches.resolved.set(key, resolved, 512);
  return resolved;
}

/** The committed bytes of one object. Concurrent identical reads share one
    `git cat-file`; at most two run at once and sixteen wait. */
export async function readBlob(lane: LanePipeline, realRepo: string, resolved: ResolvedFile, deps: TaskFilesDeps, signal?: AbortSignal): Promise<Buffer | FileFailure> {
  const key = `${realRepo}\0${resolved.oid}`;
  const warm = deps.caches.blobs.get(key);
  if (warm) return warm;
  try {
    return await deps.caches.blobFlights.join(key, signal, async (flight) => {
      const release = await deps.caches.readGate.acquire(flight);
      try {
        const result = await boundTo(deps.exec, flight)("git", ["cat-file", "blob", resolved.oid], lane.repoDir, undefined, { ...GIT_OPTIONS, stdoutEncoding: "latin1", maxOutputBytes: PREVIEW_MAX_BYTES + 1024 });
        if (result.code !== 0) throw new Error(result.stderr || "git cat-file failed");
        const bytes = Buffer.from(result.stdout, "latin1");
        if (bytes.length !== resolved.size) throw new Error("the object's size changed");
        deps.caches.blobs.set(key, bytes, bytes.length);
        return bytes;
      } finally {
        release();
      }
    });
  } catch (error) {
    if (error instanceof QueueFull) return fail(503, "busy", "too many files are being read", 2);
    if (isAbort(error)) return fail(499, "aborted", "the request was cancelled");
    return fail(500, "git_failed", "git could not read the file");
  }
}

/** Where a document's relative links resolve: its directory in the lane's
    worktree while that exists, else in the repository checkout. */
export async function documentBaseDir(lane: LanePipeline, file: string): Promise<string> {
  const directory = path.dirname(file);
  const root = lane.worktreeDir && await fs.stat(lane.worktreeDir).then((stat) => stat.isDirectory(), () => false) ? lane.worktreeDir : lane.repoDir;
  return directory === "." ? root : path.join(root, directory);
}

export { SHA_RE };
