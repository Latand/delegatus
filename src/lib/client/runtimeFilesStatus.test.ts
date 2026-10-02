import { expect, test } from "bun:test";

import { emptyStore, type RuntimeSession } from "@/components/runtime/runtimeModel";
import type { RuntimeBusState } from "@/hooks/runtimeBus";
import { createFilesClientCache } from "@/hooks/useFiles";
import type { FileEntry } from "@/lib/types";

import { createRuntimeFilesStatusProjection } from "./runtimeFilesStatus";

const file: FileEntry = {
  path: "/sessions/current.jsonl", conversationId: "conversation_status",
  root: "claude-projects", engine: "claude", fmt: "claude", kind: "session",
  name: "current", title: "Current turn", project: "demo", parent: null,
  mtime: 100, size: 1, activity: "live", proc: "running", pid: null, model: null,
  pendingQuestion: null, waitingInput: null,
  lastTurn: { startedAt: 90_000, endedAt: null },
};
const session: RuntimeSession = {
  conversationId: "conversation_status", sessionKey: { engine: "claude", sessionId: "current" },
  artifactPath: file.path, hostKind: "claude-broker", host: "hosted", turn: "idle",
  provenance: "structured", revision: 2, attentionIds: [], recentReceipts: [],
  accountId: null, parentConversationId: null, flowId: null, workflowId: null, cwd: null,
  capabilities: { steer: false, structuredAttention: true }, activeTurnId: null,
};
const runtime = (overrides: Partial<RuntimeSession> = {}): RuntimeBusState => ({
  enabled: true, structuredHostsEnabled: true, connection: "live", resyncedAt: null, lastEventAt: null,
  store: { ...emptyStore(), sessions: { [session.conversationId]: { ...session, ...overrides } } },
});
async function catalog(entry = file) {
  const cache = createFilesClientCache(async () => new Response(JSON.stringify({ files: [entry] })));
  await cache.revalidate();
  return cache;
}

test("runtime status is a UI overlay; certified bytes and transcript timings stay untouched", async () => {
  const cache = await catalog();
  try {
    const raw = cache.read();
    const next = createRuntimeFilesStatusProjection()(raw, runtime());
    expect(next.files[0]).toMatchObject({ activity: "idle", authoritativeTurn: { state: "idle" } });
    expect(next.files[0]?.lastTurn).toEqual(file.lastTurn);
    expect(raw.files[0]?.activity).toBe("live");
    expect(cache.read()).toBe(raw);
  } finally { cache.dispose(); }
});

test("text and tool events preserve catalog identity; another turn releases the idle overlay", async () => {
  const cache = await catalog();
  try {
    const raw = cache.read();
    const project = createRuntimeFilesStatusProjection();
    project(raw, runtime({ turn: "running", activeTurnId: "first" }));
    const idle = project(raw, runtime());
    expect(project(raw, runtime({ revision: 300, liveTurn: { turnId: "previous", text: "more text" } }))).toBe(idle);
    const started = project(raw, runtime({ turn: "running", activeTurnId: "next" }));
    expect(started.files[0]?.activity).toBe("live");
    expect(started).toBe(raw);
    expect(project(raw, runtime({ turn: "interrupt_requested", activeTurnId: "next" })).files[0]?.activity).toBe("live");
    expect(project(raw, runtime()).files[0]?.activity).toBe("idle");
  } finally { cache.dispose(); }
});

test("a runtime running axis cannot revive a completed transcript, even with live SSE", async () => {
  const cache = await catalog({ ...file, activity: "recent", lastTurn: { startedAt: 90_000, endedAt: 99_000 } });
  try {
    const raw = cache.read();
    expect(createRuntimeFilesStatusProjection()(raw, runtime({ turn: "running", activeTurnId: "lagged" }))).toBe(raw);
    expect(raw.files[0]?.lastTurn?.endedAt).toBe(99_000);
  } finally { cache.dispose(); }
});

test("runtime idle preserves the scanner's terminal provenance and boundary", async () => {
  const authoritativeTurn: NonNullable<FileEntry["authoritativeTurn"]> = {
    state: "terminal", source: "lifecycle", terminalAt: "2026-10-01T22:42:58.880Z",
  };
  const cache = await catalog({ ...file, activity: "recent", authoritativeTurn });
  try {
    const raw = cache.read();
    expect(createRuntimeFilesStatusProjection()(raw, runtime()).files[0]?.authoritativeTurn).toBe(raw.files[0]?.authoritativeTurn);
    expect(raw.files[0]?.authoritativeTurn).toEqual(authoritativeTurn);
  } finally { cache.dispose(); }
});

test("historical generations, derived status, unknown turns and wrong engine cannot override scanner evidence", async () => {
  const cache = await catalog();
  try {
    const raw = cache.read();
    for (const overrides of [
      { artifactPath: "/sessions/successor.jsonl" },
      { provenance: "derived" }, { turn: "unknown" },
      { sessionKey: { engine: "codex", sessionId: "current" } },
    ] as Partial<RuntimeSession>[]) {
      expect(createRuntimeFilesStatusProjection()(raw, runtime(overrides))).toBe(raw);
    }
    expect(createRuntimeFilesStatusProjection()(raw, { ...runtime(), enabled: false })).toBe(raw);
  } finally { cache.dispose(); }
});

test("path identity supports a scanner row that has not acquired its conversation id", async () => {
  const cache = await catalog({ ...file, conversationId: undefined });
  try {
    expect(createRuntimeFilesStatusProjection()(cache.read(), runtime()).files[0]?.activity).toBe("idle");
  } finally { cache.dispose(); }
});

test("settled runtime drops stale waits while a pending runtime attention keeps the question", async () => {
  const waitingInput = { since: 90, screenTail: "Choose", target: "%1", menu: null };
  const cache = await catalog({ ...file, waitingInput });
  try {
    const project = createRuntimeFilesStatusProjection();
    expect(project(cache.read(), runtime()).files[0]?.waitingInput).toBeNull();
    expect(project(cache.read(), runtime({ attentionIds: ["question"] })).files[0]?.waitingInput).toEqual(waitingInput);
  } finally { cache.dispose(); }
});

test("retained runtime status yields to fallback polls while the stream is disconnected", async () => {
  const cache = await catalog();
  const fallback = await catalog({ ...file, lastTurn: { startedAt: 200_000, endedAt: null } });
  try {
    const raw = cache.read();
    const project = createRuntimeFilesStatusProjection();
    const settled = project(raw, runtime());
    expect(settled.files[0]?.activity).toBe("idle");
    for (const connection of ["offline", "reconnecting", "degraded"] as const) {
      expect(project(raw, { ...runtime(), connection }).files[0]).toBe(settled.files[0]);
      expect(project(fallback.read(), { ...runtime(), connection })).toBe(fallback.read());
    }
    expect(project(raw, runtime()).files[0]?.activity).toBe("idle");
  } finally { cache.dispose(); fallback.dispose(); }
});

test("host shutdown and unknown recovery cannot reopen an idle turn for the same generation", async () => {
  const cache = await catalog();
  try {
    const project = createRuntimeFilesStatusProjection();
    const raw = cache.read();
    const settled = project(raw, runtime());
    for (const host of ["dead", "recovering", "unhosted"] as const) {
      expect(project(raw, runtime({ host, turn: "unknown" })).files[0]).toBe(settled.files[0]);
    }
  } finally { cache.dispose(); }
});

test("a late metadata-only replacement keeps its matching turn settlement while offline", async () => {
  let releaseLate!: (response: Response) => void;
  let requests = 0;
  const lateResponse = new Promise<Response>((resolve) => { releaseLate = resolve; });
  const cache = createFilesClientCache(async () => {
    requests += 1;
    return requests === 1
      ? new Response(JSON.stringify({ files: [file] }))
      : lateResponse;
  });
  try {
    const project = createRuntimeFilesStatusProjection();
    await cache.revalidate();
    const lateRead = cache.revalidate();
    const settled = project(cache.read(), runtime());
    releaseLate(new Response(JSON.stringify({ files: [{ ...file, title: "Updated label" }] })));
    await lateRead;

    const offline = project(cache.read(), { ...runtime(), connection: "offline" });
    expect(offline.files[0]).toMatchObject({ title: "Updated label", activity: "idle", activityReason: "runtime_turn_idle" });

    const newTurn = { ...cache.read(), files: [{ ...file, title: "Updated label", lastTurn: { startedAt: 91_000, endedAt: null } }] };
    expect(project(newTurn, { ...runtime(), connection: "offline" }).files[0]?.activity).toBe("live");
    expect(settled.files[0]?.title).toBe(file.title);
  } finally { cache.dispose(); }
});

test("a runtime running axis cannot revive a stalled open turn", async () => {
  const cache = await catalog({ ...file, activity: "stalled", activityReason: "jsonl_turn_stalled" });
  try {
    const project = createRuntimeFilesStatusProjection();
    const raw = cache.read();
    expect(project(raw, runtime({ turn: "running" })).files[0]).toMatchObject({
      activity: "stalled", activityReason: "jsonl_turn_stalled",
    });
    expect(project(raw, runtime()).files[0]?.activity).toBe("idle");
  } finally { cache.dispose(); }
});

test("the initial idle session cannot retire queued launch work, but an observed turn end can", async () => {
  for (const initialMessage of ["queued", "pending"] as const) {
    const launch = { initialMessage } as NonNullable<FileEntry["launch"]>;
    const cache = await catalog({ ...file, launch });
    try {
      const project = createRuntimeFilesStatusProjection();
      const raw = cache.read();
      expect(project(raw, runtime())).toBe(raw);
      expect(project(raw, runtime({ turn: "running", activeTurnId: "first" }))).toBe(raw);
      expect(project(raw, runtime()).files[0]?.activity).toBe("idle");
      expect(raw.files[0]?.launch?.initialMessage).toBe(initialMessage);
    } finally { cache.dispose(); }
  }
});

test("local task overlays retain settled rows and array identity without catalog-wrapper identity", async () => {
  const cache = await catalog();
  try {
    cache.applyTask({ id: "task_fixture" } as never);
    const project = createRuntimeFilesStatusProjection();
    const raw = cache.readScope();
    const settled = project(raw, runtime());
    expect(cache.readScope()).not.toBe(raw);
    expect(project(cache.readScope(), runtime()).files).toBe(settled.files);
    expect(project.updateRuntime(runtime({ revision: 10 }))).toBe(false);
    expect(project(cache.readScope(), { ...runtime(), connection: "offline" }).files[0]).toBe(settled.files[0]);
  } finally { cache.dispose(); }
});

test("idle settlement preserves an account quota warning independent of the turn", async () => {
  const rateLimit: NonNullable<FileEntry["rateLimit"]> = {
    source: "account", accountId: null, window: "session", resetAt: Date.now() / 1000 + 3600,
  };
  const cache = await catalog({ ...file, rateLimit });
  try {
    expect(createRuntimeFilesStatusProjection()(cache.read(), runtime()).files[0]?.rateLimit).toEqual(rateLimit);
  } finally { cache.dispose(); }
});
