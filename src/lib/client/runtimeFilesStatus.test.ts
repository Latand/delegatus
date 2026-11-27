import { expect, test } from "bun:test";

import { emptyStore, type RuntimeSession } from "@/components/runtime/runtimeModel";
import type { RuntimeBusState } from "@/hooks/runtimeBus";
import { createFilesClientCache } from "@/hooks/useFiles";
import type { FileEntry } from "@/lib/types";
import { catalogPositions, currentConversationFile, firstFileAtPath, indexedConversationFile, withoutArchivedPredecessors } from "@/lib/accounts/identity";
import { createCatalogSelection } from "./catalogOverlay";

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

test("a late running status for the settled turn stays idle, while a different turn wakes subscribers", async () => {
  const cache = await catalog();
  try {
    const project = createRuntimeFilesStatusProjection();
    const raw = cache.read();
    project(raw, runtime({ turn: "running", activeTurnId: "turn-one" }));
    const settled = project(raw, runtime({ turn: "idle", activeTurnId: "turn-one" }));
    project(raw, runtime({ host: "dead", turn: "unknown", activeTurnId: null }));

    expect(project.updateRuntime(runtime({ turn: "running", activeTurnId: "turn-one" }))).toBe(true);
    expect(project(raw, runtime({ turn: "running", activeTurnId: "turn-one" })).files[0]).toBe(settled.files[0]);

    project(raw, runtime({ host: "dead", turn: "unknown", activeTurnId: null }));
    expect(project.updateRuntime(runtime({ turn: "running", activeTurnId: "turn-two" }))).toBe(true);
    expect(project(raw, runtime({ turn: "running", activeTurnId: "turn-two" }))).toBe(raw);
    expect(raw.files[0]?.activity).toBe("live");
  } finally { cache.dispose(); }
});

test("terminal identity settles a batched completion without observing its running frame", async () => {
  const cache = await catalog({ ...file, launch: { initialMessage: "queued" } as NonNullable<FileEntry["launch"]> });
  try {
    const raw = cache.read();
    const project = createRuntimeFilesStatusProjection();
    expect(project(raw, runtime({ turn: "unknown" }))).toBe(raw);
    const ended = project(raw, runtime({ settledTurnId: "t1" }));
    expect(ended.files[0]?.activity).toBe("idle");
    expect(project(raw, runtime({ turn: "running", settledTurnId: "t1", activeTurnId: "t1" })).files[0]).toBe(ended.files[0]);
    expect(project(raw, runtime({ turn: "running", settledTurnId: null, activeTurnId: "t2" }))).toBe(raw);
  } finally { cache.dispose(); }
});

test("retained terminal identity in unknown or late running status cannot settle a newer scanner turn", async () => {
  const cache = await catalog();
  try {
    const raw = cache.read();
    const project = createRuntimeFilesStatusProjection();
    const settled = project(raw, runtime({ settledTurnId: "t1" }));
    const newer = { ...raw, files: [{ ...raw.files[0]!, lastTurn: { startedAt: 100_000, endedAt: null } }] };
    for (const turn of ["unknown", "running"] as const) {
      const recovery = runtime({ turn, settledTurnId: "t1", activeTurnId: turn === "running" ? "t1" : null });
      expect(project(raw, recovery).files[0]).toEqual(settled.files[0]);
      expect(project(newer, recovery)).toBe(newer);
      expect(newer.files[0]?.activity).toBe("live");
    }
  } finally { cache.dispose(); }
});

for (const engine of ["claude", "codex"] as const) {
  for (const turn of ["idle", "unknown", "running", "interrupt_requested"] as const) {
    test(`${engine}: retained end first observed in ${turn} settles only its scanner generation`, async () => {
      const cache = await catalog({ ...file, engine, fmt: engine });
      try {
        const raw = cache.read();
        const project = createRuntimeFilesStatusProjection();
        const ended = runtime({
          sessionKey: { engine, sessionId: "current" }, turn, settledTurnId: "t1",
          activeTurnId: turn === "unknown" ? null : "t1",
        });
        const settled = project(raw, ended);
        expect(settled.files[0]).toMatchObject({ activity: "idle", authoritativeTurn: { state: "idle" } });
        expect(raw.files[0]?.activity).toBe("live");
        const newer = { ...raw, files: [{ ...raw.files[0]!, lastTurn: { startedAt: 100_000, endedAt: null } }] };
        expect(project(newer, ended)).toBe(newer);
        expect(project(raw, ended).files[0]).toBe(settled.files[0]);
        const successor = runtime({ sessionKey: { engine, sessionId: "current" }, turn: "running", activeTurnId: "t2" });
        expect(project.updateRuntime(successor)).toBe(true);
        expect(project(raw, successor)).toBe(raw);
        expect(project(newer, successor)).toBe(newer);
      } finally { cache.dispose(); }
    });
  }
}

test("a bounded tail without its opening prompt binds settlement to unchanged transcript bytes", async () => {
  const cache = await catalog({ ...file, lastTurn: null });
  try {
    const raw = cache.read();
    const project = createRuntimeFilesStatusProjection();
    const ended = runtime({ turn: "unknown", settledTurnId: "t1" });
    expect(project(raw, ended).files[0]?.activity).toBe("idle");
    const relabeled = { ...raw, files: [{ ...raw.files[0]!, title: "Updated label" }] };
    expect(project(relabeled, ended).files[0]).toMatchObject({ title: "Updated label", activity: "idle" });
    const waitingInput = { since: 200, screenTail: "Choose", target: "%1", menu: null };
    for (const changedBytes of [{ size: file.size + 1 }, { mtime: file.mtime + 1 }]) {
      const newer = { ...raw, files: [{ ...raw.files[0]!, ...changedBytes, waitingInput,
        authoritativeTurn: { state: "busy", source: "assistant", terminalAt: null } as NonNullable<FileEntry["authoritativeTurn"]> }] };
      expect(project(newer, ended)).toBe(newer);
      expect(project(newer, { ...ended, connection: "offline" })).toBe(newer);
      expect(newer.files[0]?.waitingInput).toEqual(waitingInput);
    }
  } finally { cache.dispose(); }
});

test("a different turn retires a provisional settlement by its conversation and engine", async () => {
  const cache = await catalog({ ...file, path: "spawn:launch-one",
    launch: { initialMessage: "queued" } as NonNullable<FileEntry["launch"]> });
  try {
    const raw = cache.read();
    for (const artifactPath of [null, file.path]) {
      const project = createRuntimeFilesStatusProjection();
      const ended = project(raw, runtime({ artifactPath, settledTurnId: "t1" }));
      expect(ended.files[0]?.activity).toBe("idle");
      expect(project(raw, runtime({ artifactPath, turn: "running", activeTurnId: "t1", settledTurnId: "t1" }))
        .files[0]?.activity).toBe("idle");
      // A successor engine or conversation cannot retire this row's evidence.
      expect(project(raw, runtime({ artifactPath, turn: "running", activeTurnId: "t2",
        settledTurnId: null, sessionKey: { engine: "codex", sessionId: "current" } })).files[0]?.activity).toBe("idle");
      expect(project(raw, runtime({ artifactPath, conversationId: "conversation_other", turn: "running",
        activeTurnId: "t2", settledTurnId: null })).files[0]?.activity).toBe("idle");
      expect(project(raw, runtime({ artifactPath: file.path, turn: "running", activeTurnId: "t2", settledTurnId: null }))).toBe(raw);
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

test("a lifecycle change outside the catalog preserves idle row, array and snapshot identity", async () => {
  const cache = await catalog();
  try {
    const raw = cache.readScope();
    const project = createRuntimeFilesStatusProjection();
    const initial = runtime({ settledTurnId: null, activeTurnId: null });
    const settled = project(raw, initial);
    expect(settled.files[0]).not.toBe(raw.files[0]);
    const unrelated: RuntimeSession = { ...session, conversationId: "other", artifactPath: "/other", turn: "running", activeTurnId: "other-turn" };
    const changed = { ...initial, store: { ...initial.store, sessions: { ...initial.store.sessions, other: unrelated } } };
    const projected = project(raw, changed);
    expect(projected.files[0]).toBe(settled.files[0]);
    expect(projected.files).toBe(settled.files);
    expect(projected).toBe(settled);
    const nowRunning = { ...session, turn: "running" as const, activeTurnId: "new-turn" };
    const next = { ...changed, store: { ...changed.store, sessions: { ...changed.store.sessions, [session.conversationId]: nowRunning } } };
    expect(project(raw, next).files[0]).toBe(raw.files[0]);
  } finally { cache.dispose(); }
});

test("an admitted catalog visits no entries for an outside lifecycle and visits only matching positions after a path move", async () => {
  const cache = await catalog();
  try {
    const evaluated = new Set<number>();
    const source = [...Array.from({length: 64}, (_, i) => ({ ...file, path: "/sibling/" + i, conversationId: "sibling-" + i })),
      { ...file, conversationId: undefined }].map((row,index) => new Proxy(row,{
        get(target,key,receiver) {
          if (key === "conversationId" || key === "lastTurn" || key === "path") evaluated.add(index);
          return Reflect.get(target,key,receiver);
        },
      }));
    const visited = new Set<number>();
    const files = new Proxy(source, { get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) visited.add(Number(key));
      return Reflect.get(target,key,receiver);
    } });
    const raw = { ...cache.read(), files };
    const start = runtime({ artifactPath: "/elsewhere", turn: "running", activeTurnId: "first" });
    const project = createRuntimeFilesStatusProjection();
    expect(project(raw, start)).toBe(raw);
    function publish(before: RuntimeBusState, after: RuntimeBusState) {
      project.updateRuntime(after, { before: before.store, after: after.store, conversations: new Set([session.conversationId]),
        paths: new Set(), deliveries: new Set(), operations: new Set(), flows:new Set(), deployments:false });
      return project(raw, after);
    }
    const outside = runtime({ artifactPath: "/elsewhere", turn: "idle", settledTurnId: "first" });
    visited.clear(); evaluated.clear();
    expect(publish(start, outside)).toBe(raw);
    expect([...visited]).toEqual([]);
    expect([...evaluated]).toEqual([]);
    const nowHere = runtime({ artifactPath: file.path, turn: "idle", settledTurnId: "second" });
    const after = publish(outside, nowHere);
    expect([...evaluated]).toEqual([64]);
    expect(after.files[64]).toMatchObject({ authoritativeTurn: { state: "idle" } });
    // Array.slice copies references into the caller-visible immutable result.
    // A miss above must skip even that copy.
    expect(after.files[0]).toBe(source[0]);
    expect(source[64]?.authoritativeTurn).toBeUndefined();
  } finally { cache.dispose(); }
});

test("a recent overlay expires after 900 seconds on a quiet stream, including while offline", async () => {
  const cache = await catalog();
  const clock = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const raw = { ...cache.read(), files: [{ ...file, mtime:now / 1000 }] };
    for (const offline of [false, true]) {
      now = 1_000_000;
      const project = createRuntimeFilesStatusProjection();
      const live = runtime({ settledTurnId: "settled" });
      const recent = project(raw, live);
      const shown = offline ? { ...live, connection:"offline" as const } : live;
      expect(project(raw, shown).files[0]?.activity).toBe("recent");
      now = 1_899_999;
      expect(project(raw, shown).files).toBe(recent.files);
      now++;
      const idle = project(raw, shown);
      expect(idle.files[0]?.activity).toBe("idle");
      expect(recent.files[0]?.activity).toBe("recent");
      expect(project.nextExpiry()).toBe(Infinity);
      expect(project(raw, shown)).toBe(idle);
    }
  } finally { Date.now = clock; cache.dispose(); }
});


test("voice, deep links and settlement share catalog positions while held rows keep their own values", async () => {
  const cache = await catalog();
  try {
    const previous = { ...file, path:"/older", migratedTo:file.path, generation:2 };
    const placeholder = { ...file, path:"spawn:launch" };
    const source = [placeholder, previous, file];
    const raw = { ...cache.read(), files: source };
    const settled = createRuntimeFilesStatusProjection()(raw,runtime({settledTurnId:"done"}));
    expect(catalogPositions(settled.files)).toBe(catalogPositions(source));
    for (const rows of [source,settled.files]) {
      expect(indexedConversationFile(rows,session.conversationId) ?? null).toBe(currentConversationFile(rows,session.conversationId));
      expect(firstFileAtPath(rows,file.path)).toBe(rows[2]);
    }
    expect(settled.files[1]).toBe(previous);
    expect(indexedConversationFile(settled.files,session.conversationId)?.activity).toBe("idle");
    expect(indexedConversationFile(source,session.conversationId)?.activity).toBe("live");
  } finally { cache.dispose(); }
});


test("switching pinned catalog representations preserves both labels and the held terminal row", async () => {
  const cache = await catalog();
  try {
    const raw = cache.read();
    const relabeled = { ...raw, files:[{ ...raw.files[0]!, title:"Reopened from another scope" }] };
    const project = createRuntimeFilesStatusProjection();
    const ended = runtime({ settledTurnId:"retained" });
    const first = project(raw,ended);
    const second = project(relabeled,ended);
    expect(second.files[0]?.title).toBe("Reopened from another scope");
    expect(project(raw,ended).files[0]).toBe(first.files[0]);
    expect(project(relabeled,ended).files[0]).toBe(second.files[0]);
  } finally {cache.dispose();}
});

test("another project's settlement reads no row of the open project, and a neighbour's replaces its one row by position", async () => {
  const cache = await catalog();
  try {
    const read = new Set<string>();
    const watched = (entry: FileEntry) => new Proxy(entry, {
      get(target, key, receiver) {
        if (target.project === "demo") read.add(target.path);
        return Reflect.get(target, key, receiver);
      },
    });
    const row = (name: string, project: string, extra: Partial<FileEntry> = {}) => watched({ ...file, path: "/sessions/" + name, name, conversationId: name, project, ...extra });
    const source = [row("editor", "demo"), row("neighbour", "demo"), row("idle", "demo"), row("foreign", "elsewhere"),
      row("older", "demo", { conversationId: "editor", migratedTo: "/sessions/editor" })];
    const raw = { ...cache.read(), files: source };
    const sessions = (turns: Record<string, "running" | "idle">): RuntimeBusState => {
      const state = runtime();
      state.store.sessions = Object.fromEntries(Object.entries(turns).map(([id, turn]) => [id, { ...session, conversationId: id,
        artifactPath: "/sessions/" + id, turn, activeTurnId: turn === "running" ? "turn" : null, settledTurnId: turn === "idle" ? "turn" : null }]));
      return state;
    };
    const project = createRuntimeFilesStatusProjection();
    const current = createCatalogSelection(withoutArchivedPredecessors);
    const open = createCatalogSelection((rows) => rows.filter((entry) => entry.project === "demo"));
    let state = sessions({ neighbour: "running", foreign: "running" });
    const admitted = open(current(project(raw, state).files));
    expect(admitted.map((entry) => entry.name)).toEqual(["editor", "neighbour", "idle"]);
    function publish(id: string, turns: Record<string, "running" | "idle">) {
      const after = sessions(turns);
      /* The reducer keeps every untouched record. */
      for (const other of Object.keys(after.store.sessions)) if (other !== id) after.store.sessions[other] = state.store.sessions[other]!;
      project.updateRuntime(after, { before: state.store, after: after.store, conversations: new Set([id]),
        paths: new Set(["/sessions/" + id]), deliveries: new Set(), operations: new Set(), flows: new Set(), deployments: false });
      state = after;
      return open(current(project(raw, after).files));
    }

    read.clear();
    expect(publish("foreign", { neighbour: "running", foreign: "idle" })).toBe(admitted);
    expect([...read]).toEqual([]);

    const next = publish("neighbour", { neighbour: "idle", foreign: "idle" });
    expect([...read]).toEqual(["/sessions/neighbour"]);
    expect(next).not.toBe(admitted);
    expect(next[1]).toMatchObject({ name: "neighbour", authoritativeTurn: { state: "idle" } });
    expect(next[0]).toBe(admitted[0]!);
    expect(next[2]).toBe(admitted[2]!);
    /* The array on screen keeps its own row. */
    expect(admitted[1]!.authoritativeTurn).toBeUndefined();

    /* A catalog publication can project the newest sessions before the bus
       delivers their frame. It reads no more than the frame would. */
    read.clear();
    const unannounced = sessions({ offboard: "idle" });
    unannounced.store.sessions = { ...state.store.sessions, ...unannounced.store.sessions };
    expect(open(current(project(raw, unannounced).files))).toBe(next);
    expect([...read]).toEqual([]);
  } finally { cache.dispose(); }
});
