import { expect, test } from "bun:test";

import { buildMobileBoard } from "@/components/mobile/mobileBoardModel";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { createFilesClientCache, filesApiUrl } from "./useFiles";

/*
 * The board only moves forward (#2072, defects A, B and C).
 *
 * Every `/api/files` answer names the state it was built from in
 * `x-llv-files-built`: the epoch of the server's generation counter, the scan
 * generation, and the order in which its projection read the stores. The
 * client paints nothing older than what is already on screen, in any scope. A
 * stale answer, a scope the phone left minutes ago, and a 304 that would
 * restore that scope's own old rows all used to paint the board as it stood
 * minutes earlier: "Working 0" while three agents ran, and a closed lane back
 * under Needs you.
 */

const GLOBAL = filesApiUrl();
const PIN = "/archive/beyond-cap.jsonl";
const PINNED = filesApiUrl(undefined, PIN);

const built = (generation: number, sequence = generation, epoch = "e1") => `${epoch}.${generation}.${sequence}`;

function answer(body: unknown, headers: Record<string, string>, status = 200): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers });
}

function file(path: string, title: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    path,
    root: "codex-sessions",
    name: path,
    project: "project-a",
    title,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...over,
  } as FileEntry;
}

const titles = (data: { files: readonly FileEntry[] }) => data.files.map((entry) => entry.title);

test("answers built from generations 12 → 14 → 12 (stale) leave the snapshot at 14", async () => {
  const answers = [
    answer({ files: [file("/a", "A at 12")] }, { ETag: '"12"', "x-llv-files-generation": "12", "x-llv-files-built": built(12) }),
    answer({ files: [file("/a", "A at 14"), file("/b", "B at 14")] }, { ETag: '"14"', "x-llv-files-generation": "14", "x-llv-files-built": built(14) }),
    /* The server is rebuilding and hands out its previous projection, labelled
       with the live scan's generation: only the built stamp tells its age. */
    answer({ files: [file("/a", "A at 12")] }, {
      ETag: '"12"',
      "x-llv-files-generation": "14",
      "x-llv-files-target-generation": "14",
      "x-llv-files-projection-cache": "stale",
      "x-llv-files-built": built(12),
    }),
  ];
  const cache = createFilesClientCache(async () => answers.shift()!);
  const painted: string[][] = [];
  const unsubscribe = cache.subscribe((data) => painted.push(titles(data)));

  await cache.revalidate();
  await cache.revalidate();
  const newest = cache.read();
  expect(newest.builtGeneration).toBe(14);
  const afterStale = await cache.revalidate();
  cache.dispose();
  unsubscribe();

  expect(titles(cache.read())).toEqual(["A at 14", "B at 14"]);
  expect(cache.read().builtGeneration).toBe(14);
  expect(titles(afterStale)).toEqual(["A at 14", "B at 14"]);
  /* No frame ever went back to 12 once 14 was on screen. */
  expect(painted).toEqual([["A at 12"], ["A at 14", "B at 14"]]);
});

test("a dated 304 moves the generation the screen reports with the stamp it accepted", async () => {
  const answers = [
    answer({ files: [file("/a", "A")] }, { ETag: '"same"', "x-llv-files-built": built(12, 1) }),
    answer(null, { ETag: '"same"', "x-llv-files-built": built(14, 2) }, 304),
    /* An undated 304 (what a generation wait answers) dates nothing. */
    answer(null, { ETag: '"same"' }, 304),
    answer({ files: [file("/a", "A")] }, { ETag: '"older"', "x-llv-files-projection-cache": "stale", "x-llv-files-built": built(13, 9) }),
  ];
  const cache = createFilesClientCache(async () => answers.shift()!);
  const reported: Array<number | undefined> = [];
  const unsubscribe = cache.subscribe((data) => reported.push(data.builtGeneration));
  await cache.revalidate();
  expect(cache.read().builtGeneration).toBe(12);
  const confirmed = await cache.revalidate();
  expect(confirmed.builtGeneration).toBe(14);
  expect(cache.read().builtGeneration).toBe(14);
  await cache.revalidate();
  expect(cache.read().builtGeneration).toBe(14);
  /* Generation 13 is older than the 14 the 304 established. */
  await cache.revalidate();
  cache.dispose();
  unsubscribe();
  expect(cache.read().builtGeneration).toBe(14);
  expect(reported).toEqual([12, 14]);
});

test("a store change inside one scan generation is ordered by the projection's build order", async () => {
  const answers = [
    answer({ files: [file("/a", "A")], pipelines: [pipeline("lane", "closed")] }, { ETag: '"new"', "x-llv-files-built": built(14, 7) }),
    answer({ files: [file("/a", "A")], pipelines: [pipeline("lane", "needs_decision")] }, {
      ETag: '"old"',
      "x-llv-files-projection-cache": "stale",
      "x-llv-files-built": built(14, 3),
    }),
  ];
  const cache = createFilesClientCache(async () => answers.shift()!);
  await cache.revalidate();
  await cache.revalidate();
  cache.dispose();

  expect(cache.read().pipelines.map((row) => row.state)).toEqual(["closed"]);
});

test("a scope switch from pinned back to global keeps generation 14's rows", async () => {
  const cache = createFilesClientCache(async (input, init) => {
    const conditional = new Headers(init?.headers).get("If-None-Match");
    if (input === GLOBAL) {
      /* The global scope's last representation is the old one; the server
         confirms it unchanged without saying anything newer. */
      if (conditional === '"global-12"') return answer(null, { ETag: '"global-12"', "x-llv-files-built": built(12) }, 304);
      return answer({ files: [file("/a", "A at 12")] }, { ETag: '"global-12"', "x-llv-files-built": built(12) });
    }
    return answer({
      files: [file("/a", "A at 14"), file("/b", "B at 14"), file(PIN, "Pinned")],
      pinOverlayPaths: [PIN],
    }, { ETag: '"pinned-14"', "x-llv-files-built": built(14) });
  });

  await cache.revalidate();
  await cache.revalidate(PIN);
  expect(titles(cache.readScope(PIN))).toEqual(["A at 14", "B at 14", "Pinned"]);

  /* Back on the board: the newer rows stay, and the pin-only row goes with
     the scope that admitted it. */
  const back = cache.readScope();
  expect(back.requestScope).toBe(GLOBAL);
  expect(titles(back)).toEqual(["A at 14", "B at 14"]);
  expect(back.pinOverlayPaths).toEqual([]);
  expect(back.builtGeneration).toBe(14);

  /* The board's own revalidation answers 304 for its old representation: it
     restores nothing older than what is on screen. */
  const confirmed = await cache.revalidate();
  cache.dispose();
  expect(titles(confirmed)).toEqual(["A at 14", "B at 14"]);
  expect(titles(cache.readScope())).toEqual(["A at 14", "B at 14"]);
});

test("a 304 on a scope never restores older rows over newer; the scope adds its pin rows on top", async () => {
  let pinnedCalls = 0;
  const cache = createFilesClientCache(async (input) => {
    if (input === GLOBAL) {
      return answer({ files: [file("/a", "A at 14"), file("/b", "B at 14")] }, { ETag: '"global-14"', "x-llv-files-built": built(14) });
    }
    pinnedCalls += 1;
    if (pinnedCalls === 1) {
      return answer({ files: [file("/a", "A at 12"), file(PIN, "Pinned")], pinOverlayPaths: [PIN] }, { ETag: '"pinned-12"', "x-llv-files-built": built(12) });
    }
    return answer(null, { ETag: '"pinned-12"', "x-llv-files-projection-cache": "stale", "x-llv-files-built": built(12) }, 304);
  });
  /* The operator opened this conversation minutes ago, then the board moved on. */
  await cache.revalidate(PIN);
  await cache.revalidate();
  /* Opening it again: its old representation is not what comes back. */
  const pinnedFrames: string[][] = [];
  const unsubscribe = cache.subscribe((data) => pinnedFrames.push(titles(data)), PIN);
  expect(titles(cache.readScope(PIN))).toEqual(["A at 14", "B at 14", "Pinned"]);
  const reopened = await cache.revalidate(PIN);
  cache.dispose();
  unsubscribe();

  expect(titles(reopened)).toEqual(["A at 14", "B at 14", "Pinned"]);
  expect(reopened.requestScope).toBe(PINNED);
  expect(reopened.pinOverlayPaths).toEqual([PIN]);
  expect(titles(cache.readScope(PIN))).toEqual(["A at 14", "B at 14", "Pinned"]);
  expect(pinnedFrames.flat()).not.toContain("A at 12");
});

test("a restarted server starts a new epoch: its first answer paints, and no scope from before it comes back", async () => {
  let restarted = false;
  const cache = createFilesClientCache(async (input, init) => {
    const conditional = new Headers(init?.headers).get("If-None-Match");
    if (input === PINNED) {
      /* A generation wait echoes the client's own ETag and dates nothing. */
      if (conditional) return answer(null, { ETag: conditional, "x-llv-files-generation": "1", "x-llv-files-target-generation": "2" }, 304);
      return answer({ files: [file("/a", "Before the restart"), file(PIN, "Pinned")], pinOverlayPaths: [PIN] }, { ETag: '"pinned-before"', "x-llv-files-built": built(500, 900, "old") });
    }
    return restarted
      ? answer({ files: [file("/a", "After the restart")] }, { ETag: '"after"', "x-llv-files-built": built(1, 1, "new") })
      : answer({ files: [file("/a", "Before the restart")] }, { ETag: '"before"', "x-llv-files-built": built(500, 901, "old") });
  });
  await cache.revalidate(PIN);
  await cache.revalidate();
  restarted = true;
  await cache.revalidate();
  expect(titles(cache.read())).toEqual(["After the restart"]);
  expect(cache.read().builtGeneration).toBe(1);

  /* The conversation opened before the restart: the rows after it, and its pin. */
  expect(titles(cache.readScope(PIN))).toEqual(["After the restart", "Pinned"]);
  const waited = await cache.revalidate(PIN);
  cache.dispose();
  expect(titles(waited)).toEqual(["After the restart", "Pinned"]);
});

/* The operator's two frames one minute apart (§2.3). At 09:23 the board had
   three lanes working and the chips lane closed; at 09:23:57 it drew the
   09:19 projection again: Working 0, and the closed lane under Needs you. */
const NOW = 1_800_000_000;
const PROJECT = "atlas";

function lane(path: string, title: string): FileEntry {
  return file(path, title, {
    root: "claude-projects",
    engine: "claude",
    fmt: "claude",
    project: PROJECT,
    mtime: NOW - 30,
    activity: "live",
    proc: "running",
    pid: 4_401,
    lastTurn: { startedAt: (NOW - 180) * 1_000, endedAt: null },
  } as Partial<FileEntry>);
}

function finished(path: string, title: string): FileEntry {
  return file(path, title, { root: "claude-projects", engine: "claude", fmt: "claude", project: PROJECT, mtime: NOW - 3_600, activity: "idle" });
}

function pipeline(id: string, state: Pipeline["state"]): Pipeline {
  return {
    id,
    task: "PR and issue chips on pipelines and task cards",
    taskIds: [],
    project: PROJECT,
    repoDir: "/repo",
    worktreeDir: "/repo-lane",
    branch: `lane/${id}`,
    baseBranch: "main",
    baseRef: "main",
    lastPassedCommit: "",
    stages: [{ id: "implement", kind: "run" }, { id: "review", kind: "run" }],
    runs: [],
    cursor: state === "needs_decision" ? { stageId: "review", attempt: 1 } : null,
    state,
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: new Date((NOW - 7_200) * 1_000).toISOString(),
    closedAt: state === "closed" ? new Date((NOW - 180) * 1_000).toISOString() : null,
    hiddenAt: null,
  } as unknown as Pipeline;
}

const AT_0919 = {
  files: [finished("/favicon.jsonl", "Favicon"), finished("/skeletons.jsonl", "Skeletons"), finished("/review.jsonl", "Review round 2")],
  pipelines: [pipeline("chips", "needs_decision")],
};
const AT_0923 = {
  files: [lane("/favicon.jsonl", "Favicon"), lane("/skeletons.jsonl", "Skeletons"), lane("/review.jsonl", "Review round 2")],
  pipelines: [pipeline("chips", "closed")],
};

test("the incident replayed: the 09:23 board then the 09:19 payload keeps Working 3 and no closed lane", async () => {
  const answers = [
    answer(AT_0923, { ETag: '"0923"', "x-llv-files-generation": "14", "x-llv-files-built": built(14) }),
    answer(AT_0919, {
      ETag: '"0919"',
      "x-llv-files-generation": "14",
      "x-llv-files-target-generation": "14",
      "x-llv-files-projection-cache": "stale",
      "x-llv-files-built": built(12),
    }),
  ];
  const cache = createFilesClientCache(async () => answers.shift()!);
  await cache.revalidate();
  await cache.revalidate();
  cache.dispose();

  const data = cache.read();
  const board = buildMobileBoard({ files: data.files, pipelines: data.pipelines, project: PROJECT, now: NOW });
  expect(data.builtGeneration).toBe(14);
  expect(board.working.map((row) => row.title).sort()).toEqual(["Favicon", "Review round 2", "Skeletons"]);
  expect(board.needsYou.filter((item) => item.kind === "pipeline")).toEqual([]);
});

test("an incomplete pinned answer keeps the newest rows and adds only the scope's own pin, then the board keeps them", async () => {
  const pinRow = finished(PIN, "Opened from All conversations");
  let pinnedCalls = 0;
  const cache = createFilesClientCache(async (input) => {
    if (input === GLOBAL) return answer(AT_0923, { ETag: '"0923"', "x-llv-files-generation": "14", "x-llv-files-built": built(14) });
    pinnedCalls += 1;
    if (pinnedCalls === 1) {
      return answer({ ...AT_0919, files: [...AT_0919.files, pinRow], pinOverlayPaths: [PIN] }, { ETag: '"pinned-0919"', "x-llv-files-built": built(12) });
    }
    /* The pin's own scan has not caught up: the server answers the pinned
       scope with its newest global rows, and says the target is still ahead. */
    return answer(AT_0923, {
      ETag: '"pinned-global-only"',
      "x-llv-files-generation": "14",
      "x-llv-files-target-generation": "15",
      "x-llv-files-built": built(14, 15),
    });
  });
  const unsubscribe = cache.subscribe(() => {}, PIN);

  await cache.revalidate(PIN);
  await cache.revalidate();
  const pinned = await cache.revalidate(PIN);
  const shown = cache.read();
  const back = cache.readScope();
  cache.dispose();
  unsubscribe();

  const boardOf = (data: { files: readonly FileEntry[]; pipelines: readonly Pipeline[] }) =>
    buildMobileBoard({ files: data.files, pipelines: data.pipelines, project: PROJECT, now: NOW });
  for (const data of [pinned, shown]) {
    expect(data.builtGeneration).toBe(14);
    expect(boardOf(data).working).toHaveLength(3);
    expect(data.pipelines.map((row) => row.state)).toEqual(["closed"]);
    /* The deep link keeps its conversation while the pin's scan catches up. */
    expect(data.files.map((row) => row.path)).toContain(PIN);
  }
  expect(pinned.pinOverlayPaths).toEqual([PIN]);

  /* Back on the board: generation 14's rows, without the pin. */
  expect(back.builtGeneration).toBe(14);
  expect(back.files.map((row) => row.path)).not.toContain(PIN);
  expect(boardOf(back).working).toHaveLength(3);
  expect(boardOf(back).needsYou.filter((item) => item.kind === "pipeline")).toEqual([]);
  expect(back.pipelines.map((row) => row.state)).toEqual(["closed"]);
});
