import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeAgentRegistryForTests } from "@/lib/agent/registry";
import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";
import { answerAttentionRequest, awaitAttentionArrival, raiseAttentionRequest } from "@/lib/attention/service";
import { readAttentionFile } from "@/lib/attention/store";
import type { AttentionRequestV1 } from "@/lib/attention/types";
import { persistProjectAliases } from "@/lib/projects/aliases";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { resetPresenceForTest, upsertPresence } from "@/lib/view/presenceStore";
import type { PresencePayloadV1 } from "@/lib/view/types";

import { viewerMcpBindings } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, type McpToolResult } from "./server";

/*
 * An agent's request_attention moves the operator's view only inside the
 * project the operator is in. For a target in another project the call answers
 * at once as a notice, nothing is directed at any view, and the notification
 * is what reaches them. The comparison is made on canonical project identity.
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-attention-boundary-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetPresenceForTest();
});
afterEach(() => {
  resetPresenceForTest();
  closeAgentRegistryForTests();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const REVIEWER = "/tmp/reviewer.jsonl";
const TARGET_PROJECT = "repo-target";

const reviewerFile = {
  path: REVIEWER,
  project: TARGET_PROJECT,
  title: "Reviewer — login fix",
  engine: "claude",
  activity: "live",
} as unknown as FileEntry;

const ROOT_CALLER: AttentionCallerAuthority = { kind: "root", conversationId: "conversation_root" };

const fastArrival: typeof awaitAttentionArrival = (id, options = {}) =>
  awaitAttentionArrival(id, { pollMs: 5, timeoutMs: 1_500, ...options });

function service(overrides: Record<string, unknown> = {}) {
  return createMcpToolService(viewerMcpBindings(undefined, undefined, {
    completedFileScan: async () => ({ snapshot: { files: [], projectCatalog: [], complete: true } }),
    listFiles: async () => [reviewerFile],
    loadTasks: () => [] as BoardTask[],
    getPipelines: () => ({ pipelines: [] }),
    getFlowsWithPresets: () => ({ flows: [] }),
    adoptRootSession: () => {},
    attentionAuthority: () => ROOT_CALLER,
    raiseAttentionRequest,
    awaitAttentionArrival: fastArrival,
    ...overrides,
  } as never), new MemoryMcpReceiptStore());
}

const ask = (overrides: Record<string, unknown> = {}) => ({
  clientRequestId: "boundary-1",
  target: { kind: "conversation", path: REVIEWER },
  reason: "The reviewer finished with request-changes.",
  ...overrides,
});

function openView(overrides: Partial<PresencePayloadV1> = {}): PresencePayloadV1 {
  return {
    schemaVersion: 1,
    viewSessionId: "view-1",
    deviceId: "device-desktop",
    device: { kind: "desktop", browser: "chrome" },
    visibility: "visible",
    sequence: 1,
    inputSequence: 1,
    project: TARGET_PROJECT,
    mode: "scheme",
    viewport: { width: 1_600, height: 900, dpr: 2 },
    camera: { x: 10, y: 20, zoom: 0.6, worldRect: { x: 0, y: 0, width: 100, height: 80 } },
    focusedPath: null,
    selectedPaths: [],
    visiblePaths: [],
    board: { renderedRevision: 4, durableRevision: 4, sync: "current" },
    ...overrides,
  };
}

/** The browser's half, played against the real record. */
function browserStandIn(deviceId: string, onAccepted: (request: AttentionRequestV1) => void) {
  const timer = setInterval(() => {
    try {
      for (const request of readAttentionFile().requests) {
        if (request.state === "accepted" && request.acknowledgedBy === deviceId) onAccepted(request);
      }
    } catch {
      /* mid-write read; the next tick sees the settled file */
    }
  }, 10);
  return () => clearInterval(timer);
}

const arriveOn = (deviceId: string) => (request: AttentionRequestV1) => {
  answerAttentionRequest(request.id, {
    kind: "arrive",
    deviceId,
    returnPoint: { deviceId, capturedAt: new Date().toISOString(), mode: "scheme", camera: null, focusedPath: null },
    resolution: "exact",
  });
};

type Answer = McpToolResult & { delivered?: string; handoff?: unknown; request?: AttentionRequestV1 };

test("a target in the project the operator is in keeps today's move", async () => {
  upsertPresence(openView({ project: TARGET_PROJECT }));
  const stop = browserStandIn("device-desktop", arriveOn("device-desktop"));
  try {
    const result = await service().callTool("request_attention", ask()) as Answer;
    expect(result.ok).toBe(true);
    expect(result.delivered).toBeUndefined();
    expect(readAttentionFile().requests[0]!.state).toBe("following");
  } finally {
    stop();
  }
});

test("a target in another project answers at once as a notice and directs nothing at any view", async () => {
  upsertPresence(openView({ project: "repo-other" }));
  let waits = 0;
  const result = await service({ awaitAttentionArrival: async () => { waits += 1; return { kind: "failed", code: "HANDOFF_TIMEOUT", request: null }; } })
    .callTool("request_attention", ask()) as Answer;

  expect(result.ok).toBe(true);
  expect(result.delivered).toBe("notice");
  expect(result.handoff).toBeNull();
  expect(waits).toBe(0);
  const [stored] = readAttentionFile().requests;
  expect(stored).toMatchObject({ state: "pending", delivery: "notice", offeredTo: [], target: { kind: "conversation", path: REVIEWER } });
  expect(stored!.acknowledgedBy).toBeUndefined();
  expect(stored!.directedSessionId).toBeUndefined();
  expect(stored!.returnPoints).toEqual([]);
});

test("the notice answer replays by clientRequestId without a second record", async () => {
  upsertPresence(openView({ project: "repo-other" }));
  const first = await service().callTool("request_attention", ask()) as Answer;
  const replay = await createMcpToolService(viewerMcpBindings(undefined, undefined, {
    completedFileScan: async () => ({ snapshot: { files: [], projectCatalog: [], complete: true } }),
    listFiles: async () => [reviewerFile],
    loadTasks: () => [] as BoardTask[],
    getPipelines: () => ({ pipelines: [] }),
    getFlowsWithPresets: () => ({ flows: [] }),
    adoptRootSession: () => {},
    attentionAuthority: () => ROOT_CALLER,
    raiseAttentionRequest,
    awaitAttentionArrival: fastArrival,
  } as never), new MemoryMcpReceiptStore()).callTool("request_attention", ask()) as Answer;
  expect(replay.delivered).toBe("notice");
  expect(replay.request?.id).toBe(first.request?.id);
  expect(readAttentionFile().requests).toHaveLength(1);
});

test("a key that moved is the same project: an alias on either side still moves the view", async () => {
  expect(persistProjectAliases([{ source: "repo-old", target: TARGET_PROJECT, displayName: "Target" }])).toBe(true);

  upsertPresence(openView({ project: "repo-old" }));
  let stop = browserStandIn("device-desktop", arriveOn("device-desktop"));
  try {
    const viewAlias = await service().callTool("request_attention", ask({ clientRequestId: "alias-view" })) as Answer;
    expect(viewAlias.delivered).toBeUndefined();
    expect(readAttentionFile().requests.at(-1)!.state).toBe("following");
  } finally {
    stop();
  }

  resetPresenceForTest();
  upsertPresence(openView({ project: TARGET_PROJECT }));
  stop = browserStandIn("device-desktop", arriveOn("device-desktop"));
  try {
    const targetAlias = await service().callTool("request_attention", ask({ clientRequestId: "alias-target", project: "repo-old" })) as Answer;
    expect(targetAlias.delivered).toBeUndefined();
    expect(readAttentionFile().requests.at(-1)!.state).toBe("following");
  } finally {
    stop();
  }
});

test("a view with no project open (the overview) keeps today's move", async () => {
  upsertPresence(openView({ project: null, mode: "overview" }));
  const stop = browserStandIn("device-desktop", arriveOn("device-desktop"));
  try {
    const result = await service().callTool("request_attention", ask()) as Answer;
    expect(result.delivered).toBeUndefined();
    expect(readAttentionFile().requests[0]!.state).toBe("following");
  } finally {
    stop();
  }
});

test("the operator switches project while the move is in flight: the view stands down and the call answers as the notice", async () => {
  upsertPresence(openView({ project: TARGET_PROJECT }));
  let moved = 0;
  const stop = browserStandIn("device-desktop", (request) => {
    /* The browser reads its project at the moment it would move, and the
       operator is somewhere else now. */
    const stood = answerAttentionRequest(request.id, { kind: "stand-down", deviceId: "device-desktop" });
    if (!stood.ok) moved += 1;
  });
  try {
    const result = await service().callTool("request_attention", ask()) as Answer;
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe("notice");
    expect(result.handoff).toBeNull();
    expect(moved).toBe(0);
    expect(readAttentionFile().requests[0]).toMatchObject({ state: "pending", delivery: "notice", returnPoints: [] });
  } finally {
    stop();
  }
});

test("no active view stays the explicit NO_ACTIVE_VIEW and records nothing", async () => {
  const result = await service().callTool("request_attention", ask());
  expect(result.ok).toBe(false);
  expect((result as { details?: { code?: string } }).details?.code).toBe("NO_ACTIVE_VIEW");
  expect(readAttentionFile().requests).toEqual([]);
});
