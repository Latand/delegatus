import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import {
  AgentRegistry,
  readOnlyConversationLookupFromSnapshot,
  setAgentRegistryForTests,
  type RegistryFile,
} from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import { setStateFreeBytesProbeForTests } from "@/lib/state/diskFull";

import { buildFilesResponse } from "./response";
import { createHash } from "node:crypto";
import { estimateShallowMemoryUsageOf } from "bun:jsc";
import { BoardEncoder } from "@/lib/boardEncoding";
import { BoardHistory } from "@/lib/boardHistory";
import { applyBoardDelta } from "@/lib/boardDelta";
import { diffFilesBodies } from "@/lib/filesDelta";
import { gzipBody } from "@/lib/http/gzipBody";

let registryRoot = "";
let stateDir = "";
const previousState = process.env.LLV_STATE_DIR;

beforeEach(() => {
  setStateFreeBytesProbeForTests(() => 1024 ** 3);
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-perf-"));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-perf-state-"));
  process.env.LLV_STATE_DIR = stateDir;
});

afterEach(() => {
  setStateFreeBytesProbeForTests(null);
  setAgentRegistryForTests(null);
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(registryRoot, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const CONVERSATIONS = 4_500;
const SCANNED_FILES = 400;
const LINEAGE_EDGES = 2_000;
const FIXTURE_NOW = "2026-07-30T00:00:00.000Z";

type FixtureConversationId = RegistryFile["conversations"][string]["id"];

function conversationId(index: number): FixtureConversationId {
  return `conversation_perf-${index}` as FixtureConversationId;
}

function sessionPath(index: number): string {
  return `/sessions/perf/rollout-${index}.jsonl`;
}

/** A production-shaped registry snapshot: thousands of conversations with
    launch profiles plus a lineage-edge population, built in memory so the
    fixture never touches a real state directory. */
function productionShapedSnapshot(registry: AgentRegistry): RegistryFile {
  const snapshot = registry.snapshot();
  for (let index = 0; index < CONVERSATIONS; index += 1) {
    const id = conversationId(index);
    const pathname = sessionPath(index);
    snapshot.conversations[id] = {
      id,
      engine: "codex",
      generations: [{
        id: `generation-perf-${index}`,
        path: pathname,
        accountId: null,
        launchProfile: emptyLaunchProfile({ title: `Perf session ${index}`, project: "perf-project" }),
        historyHash: null,
        host: null,
        createdAt: FIXTURE_NOW,
        archivedAt: null,
      }],
      continuityPaths: [],
      abandonedContinuityPaths: [],
      providerForkPaths: [],
      projectOwnership: null,
      migration: null,
      migrationOptOut: null,
      deliveryEvidenceTracked: true,
      supersededBy: null,
      agentRole: null,
      delegationDepth: null,
      turn: { state: "unknown", source: "empty", terminalAt: null, observedAt: null },
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW,
    } as RegistryFile["conversations"][string];
  }
  for (let index = 1; index <= LINEAGE_EDGES; index += 1) {
    snapshot.lineageEdges[conversationId(index)] = {
      childConversationId: conversationId(index),
      parentConversationId: conversationId(0),
      childSessionKey: null,
      parentSessionKey: null,
      childArtifactPath: sessionPath(index),
      parentArtifactPath: sessionPath(0),
      kind: "spawn",
      role: null,
      reviewsConversationId: null,
      source: "viewer-spawn",
      evidence: { launchId: null, clientAttemptId: null },
      createdAt: FIXTURE_NOW,
    };
  }
  return snapshot;
}

function scannedFile(index: number): FileEntry {
  return {
    path: sessionPath(index),
    root: "codex-sessions",
    name: `rollout-${index}.jsonl`,
    project: "perf-project",
    title: "",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

test("issue 798: a production-shaped files projection reads the registry once and is byte-stable", async () => {
  const registry = new AgentRegistry(path.join(registryRoot, "registry.json"));
  const snapshot = productionShapedSnapshot(registry);
  let registryReads = 0;
  (registry as unknown as { readOnlySnapshot: () => RegistryFile }).readOnlySnapshot = () => {
    registryReads += 1;
    return snapshot;
  };
  setAgentRegistryForTests(registry);
  const dependencies = {
    listFilesWithProjectCatalog: async () => ({
      files: Array.from({ length: SCANNED_FILES }, (_, index) => scannedFile(index)),
      projectCatalog: [],
      complete: true,
    }),
  };
  const request = () => new Request("http://127.0.0.1/api/files");

  const coldStartedAt = performance.now();
  const cold = await buildFilesResponse(request(), dependencies);
  const coldDuration = performance.now() - coldStartedAt;
  expect(cold.status).toBe(200);
  /* The whole request holds ONE registry snapshot: identity/lineage stamping,
     the title overlay, and the project catalog all consume it. A second read
     is the #798 regression (the title projector re-projecting the registry). */
  expect(registryReads).toBe(1);

  const warmStartedAt = performance.now();
  const warm = await buildFilesResponse(request(), dependencies);
  const warmDuration = performance.now() - warmStartedAt;
  expect(warm.status).toBe(200);
  expect(registryReads).toBe(2);

  const coldBody = await cold.json() as { files: Array<{ path: string; conversationId?: string; parent?: string | null }> };
  expect(coldBody.files).toHaveLength(SCANNED_FILES);
  expect(coldBody.files[1]?.conversationId).toBe(conversationId(1));
  expect(coldBody.files[1]?.parent).toBe(sessionPath(0));
  /* Byte-stable output: identical inputs produce an identical strong ETag, so
     the projection carries no per-request nondeterminism. */
  expect(warm.headers.get("etag")).toBe(cold.headers.get("etag"));

  /* The #798 regressions are held by counts, not by the clock: the single
     registry read above, and the shared-structure lookup in the next test for
     the per-entry deep clones. The timings are reported, never asserted (#1761). */
  console.log(JSON.stringify({ probe: "issue-798-files-projection", coldMs: Math.round(coldDuration), warmMs: Math.round(warmDuration) }));
});

test("issue 798: the read-only conversation lookup shares snapshot structure instead of cloning per call", () => {
  const registry = new AgentRegistry(path.join(registryRoot, "registry.json"));
  const snapshot = productionShapedSnapshot(registry);
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const owned = snapshot.conversations[conversationId(7)];
  expect(lookup.conversationForPath(sessionPath(7))).toBe(owned!);
  expect(lookup.conversation(conversationId(7))).toBe(owned!);
  expect(lookup.conversationForPath("/sessions/perf/unknown.jsonl")).toBeNull();
});

/* Private, frozen production bodies are read only. The report contains counts
 * and timings; payload text and filesystem names never leave this process. */
test.skipIf(!process.env.BOARD_POLL_BASE_FILE || !process.env.BOARD_POLL_NEXT_FILE)("board poll production-size encoding replay", async () => {
  type Json = Record<string, unknown>;
  const aBody = fs.readFileSync(process.env.BOARD_POLL_BASE_FILE!, "utf8");
  const bBody = fs.readFileSync(process.env.BOARD_POLL_NEXT_FILE!, "utf8");
  const a = JSON.parse(aBody) as Json;
  const b = JSON.parse(bBody) as Json;
  const largest = (rows: Json[]) => rows.reduce((best, row) => JSON.stringify(row).length > JSON.stringify(best).length ? row : best);
  const large = structuredClone(b);
  const pipeline = largest(large.pipelines as Json[]);
  pipeline.state = pipeline.state === "running" ? "paused" : "running";
  const task = largest(large.tasks as Json[]);
  task.details = `${task.details ?? ""}\nOne more recorded detail.`;
  const reports: unknown[] = [];
  for (const [name, before, after] of [["observed", a, b], ["largest-records", b, large]] as const) {
    const oldBody = JSON.stringify(before);
    const oldTag = `"${createHash("sha1").update(oldBody).digest("hex")}"`;
    const samples: unknown[] = [];
    let finalDelta = "", full = "";
    for (let sample = 0; sample < 8; sample++) {
      const encoder = new BoardEncoder();
      const base = encoder.encode("global", "replay", before);
      const start = performance.now();
      const body = JSON.stringify(after);
      const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
      const serialized = performance.now();
      const oldDelta = diffFilesBodies(oldBody, body, oldTag, etag);
      const baselineDone = performance.now();
      const next = encoder.encode("global", "replay", after);
      const candidateDone = performance.now();
      expect(applyBoardDelta(JSON.parse(base.body), JSON.parse(next.delta!.body))).toEqual(JSON.parse(next.body));
      finalDelta = `{"deltas":[${next.delta!.body}]}`;
      full = next.body;
      if (sample) samples.push({ serializeHashMs: serialized - start, v1DiffMs: baselineDone - serialized,
        baselineBuildMs: baselineDone - start, candidateBuildMs: candidateDone - baselineDone, v1DeltaBytes: Buffer.byteLength(oldDelta) });
    }
    const countStrings = (run: () => unknown) => {
      const stringify = JSON.stringify, parse = JSON.parse;
      let calls = 0, stringBytes = 0, shallowStringBytes = 0, parseBytes = 0;
      JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
        const value = stringify(...args);
        if (value !== undefined) { calls++; stringBytes += Buffer.byteLength(value); shallowStringBytes += estimateShallowMemoryUsageOf(value); }
        return value;
      }) as typeof JSON.stringify;
      JSON.parse = ((value: string, ...args: []) => { parseBytes += Buffer.byteLength(value); return parse(value, ...args); }) as typeof JSON.parse;
      try { run(); } finally { JSON.stringify = stringify; JSON.parse = parse; }
      return { calls, stringBytes, shallowStringBytes, parseBytes };
    };
    const encoder = new BoardEncoder();
    const base = encoder.encode("global", "replay", before);
    const baselineAllocation = countStrings(() => {
      const body = JSON.stringify(after);
      diffFilesBodies(oldBody, body, oldTag, `"${createHash("sha1").update(body).digest("hex")}"`);
    });
    const candidateAllocation = countStrings(() => encoder.encode("global", "replay", after));
    const next = encoder.encode("global", "replay", before);
    const history = new BoardHistory();
    history.record("global", base.etag, next.etag + "target", JSON.parse(finalDelta).deltas.map((d: unknown) => JSON.stringify(d)).join(","));
    const answer = history.answer("global", base.etag, next.etag + "target", Buffer.byteLength(full)).answer!;
    expect(answer).toBeDefined();
    const pollAllocation = countStrings(() => history.answer("global", base.etag, next.etag + "target", Buffer.byteLength(full)));
    const gzip = await gzipBody(finalDelta);
    reports.push({ name, fullBytes: Buffer.byteLength(full), fullGzipBytes: (await gzipBody(full)).length,
      deltaBytes: Buffer.byteLength(finalDelta), deltaGzipBytes: gzip.length, samples, baselineAllocation, candidateAllocation, cachedPollAllocation: pollAllocation });
    expect(Buffer.byteLength(finalDelta)).toBeLessThan(Buffer.byteLength(full) / 10);
  }
  const result = { inputSha256: [aBody, bBody].map(body => createHash("sha256").update(body).digest("hex")), reports };
  if (process.env.BOARD_POLL_REPORT) fs.writeFileSync(process.env.BOARD_POLL_REPORT, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ probe: "board-poll-encoding", ...result }));
}, 120_000);
