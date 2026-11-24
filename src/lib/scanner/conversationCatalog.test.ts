import { expect, test } from "bun:test";

import type { ConversationCatalogEntry } from "./conversationCatalog";
import { catalogEntryToFileEntry, conversationCatalogGeneration, conversationCatalogProjectsSnapshot, ExpiredConversationCatalogCursorError, loadConversationCatalogPage, paginateConversationCatalog, replaceConversationCatalog } from "./conversationCatalog";
import { schemeWindowConfig, selectSchemeWindow } from "./schemeWindow";

function entry(index: number, project = "viewer"): ConversationCatalogEntry {
  return {
    path: `/sessions/${index}.jsonl`,
    root: "codex-sessions",
    name: `${index}.jsonl`,
    project,
    title: `Conversation ${index}`,
    firstPrompt: `Prompt ${index}`,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    mtime: index,
    size: index * 100,
  };
}

test("project membership is indexed once per catalog generation, independent of conversation count", () => {
  const generation = conversationCatalogGeneration();
  replaceConversationCatalog(Array.from({ length: 53_299 }, (_, index) => entry(index, index === 53_298 ? "other" : "history")));
  const first = conversationCatalogProjectsSnapshot();
  expect([...first].sort()).toEqual(["history", "other"]);
  expect(conversationCatalogProjectsSnapshot()).toBe(first);
  expect(conversationCatalogGeneration()).toBe(generation + 1);
  replaceConversationCatalog([entry(1, "fresh")]);
  expect([...conversationCatalogProjectsSnapshot()]).toEqual(["fresh"]);
  expect(conversationCatalogGeneration()).toBe(generation + 2);
});

test("conversation listing paginates every catalog conversation without a scheme cap", () => {
  const catalog = Array.from({ length: 7 }, (_, index) => entry(index + 1));
  const first = paginateConversationCatalog(catalog, { project: "viewer", limit: 3 });
  const second = paginateConversationCatalog(catalog, { project: "viewer", limit: 3, cursor: first.nextCursor });
  const third = paginateConversationCatalog(catalog, { project: "viewer", limit: 3, cursor: second.nextCursor });

  expect([...first.items, ...second.items, ...third.items].map((item) => item.path)).toEqual([
    "/sessions/7.jsonl",
    "/sessions/6.jsonl",
    "/sessions/5.jsonl",
    "/sessions/4.jsonl",
    "/sessions/3.jsonl",
    "/sessions/2.jsonl",
    "/sessions/1.jsonl",
  ]);
  expect(first.nextCursor).toBeString();
  expect(second.nextCursor).toBeString();
  expect(third.nextCursor).toBeNull();
  expect(first.total).toBe(7);
});

test("pagination keeps its original rows when mtimes refresh between pages", () => {
  const catalog = Array.from({ length: 7 }, (_, index) => entry(index + 1));
  const first = paginateConversationCatalog(catalog, { limit: 3 });
  const refreshed = catalog.map((item) => item.path === "/sessions/4.jsonl" ? { ...item, mtime: 100 } : item);
  const second = paginateConversationCatalog(refreshed, { limit: 3, cursor: first.nextCursor });
  const third = paginateConversationCatalog(refreshed, { limit: 3, cursor: second.nextCursor });

  expect([...first.items, ...second.items, ...third.items].map((item) => item.path)).toEqual([
    "/sessions/7.jsonl",
    "/sessions/6.jsonl",
    "/sessions/5.jsonl",
    "/sessions/4.jsonl",
    "/sessions/3.jsonl",
    "/sessions/2.jsonl",
    "/sessions/1.jsonl",
  ]);
});

test("abandoned uncapped pagination snapshots have an aggregate row budget", () => {
  const catalog = Array.from({ length: 7_000 }, (_, index) => entry(index + 1));
  const first = paginateConversationCatalog(catalog, { limit: 1 });
  paginateConversationCatalog(catalog, { limit: 1 });
  paginateConversationCatalog(catalog, { limit: 1 });

  expect(() => paginateConversationCatalog(catalog, { limit: 1, cursor: first.nextCursor }))
    .toThrow(ExpiredConversationCatalogCursorError);
});

test("search finds a conversation excluded by the scheme project and card caps", () => {
  const catalog = [
    entry(30, "recent-a"),
    entry(29, "recent-a"),
    entry(20, "recent-b"),
    { ...entry(10, "quiet-c"), title: "Quiet title", firstPrompt: "Investigate cobalt orchard" },
  ];
  const scheme = selectSchemeWindow(catalog, (item) => item.project, { projectCap: 2, cardsPerProject: 1 });
  const result = paginateConversationCatalog(catalog, { query: "cobalt orchard", limit: 10 });

  expect(scheme.map((item) => item.path)).not.toContain("/sessions/10.jsonl");
  expect(result.items.map((item) => item.path)).toEqual(["/sessions/10.jsonl"]);
  expect(result.items[0]?.firstPrompt).toBe("");
});

test("a list page stats only the conversations returned on that page", async () => {
  const catalog = Array.from({ length: 12 }, (_, index) => entry(index + 1));
  const statPaths: string[] = [];
  const metadataPaths: string[] = [];
  const page = await loadConversationCatalogPage(catalog, { limit: 4 }, async (pathname) => {
    statPaths.push(pathname);
    return { size: 999, mtimeMs: 50_000 };
  }, async (item) => {
    metadataPaths.push(item.path);
    return { ...item, title: `Hydrated ${item.title}` };
  });

  expect(statPaths).toEqual(page.items.map((item) => item.path));
  expect(metadataPaths).toEqual(statPaths);
  expect(statPaths).toHaveLength(4);
  expect(page.items.every((item) => item.size === 999)).toBe(true);
  expect(page.items.every((item) => item.title.startsWith("Hydrated "))).toBe(true);
  expect(page.nextCursor).toBeString();
});

test("page hydration omits confirmed disappearance and surfaces transient stat failures", async () => {
  const missing = entry(1);
  const missingPage = await loadConversationCatalogPage([missing], {}, async () => {
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  });
  expect(missingPage.items).toEqual([]);
  expect(missingPage.total).toBe(1);

  await expect(loadConversationCatalogPage([entry(2)], {}, async () => {
    throw Object.assign(new Error("busy"), { code: "EMFILE" });
  })).rejects.toThrow("busy");
});

test("scheme project and card caps are independently configurable", () => {
  expect(schemeWindowConfig({ LLV_SCHEME_PROJECT_CAP: "3", LLV_SCHEME_CARDS_PER_PROJECT: "7" })).toEqual({
    projectCap: 3,
    cardsPerProject: 7,
  });
});

test("a fresh transcript never reads idle in list rows — activity carries the scanner's mtime tier (#1038 review)", () => {
  const nowMs = 1_780_000_000_000;
  const fresh = catalogEntryToFileEntry({ ...entry(1), mtime: nowMs / 1000 - 60 }, nowMs);
  const aged = catalogEntryToFileEntry({ ...entry(2), mtime: nowMs / 1000 - 3_600 }, nowMs);
  expect(fresh.activity).toBe("recent");
  expect(aged.activity).toBe("idle");
});

/* Issue #1207: an OpenClaw conversation must be a first-class row in the
   complete list, reachable by both title and first-prompt search. */
test("an OpenClaw conversation lists and searches beside Claude and Codex rows", () => {
  const openclaw: ConversationCatalogEntry = {
    path: "/openclaw/agents/primary/sessions/oc-session-alpha.jsonl",
    root: "openclaw-sessions",
    name: "oc-session-alpha.jsonl",
    project: "viewer",
    title: "Draft the cobalt orchard note",
    firstPrompt: "Draft the cobalt orchard note about seedlings",
    engine: "openclaw",
    kind: "session",
    fmt: "openclaw",
    mtime: 9,
    size: 512,
  };
  const catalog = [entry(1), openclaw, entry(2)];

  expect(paginateConversationCatalog(catalog, { project: "viewer" }).items.map((item) => item.path))
    .toContain(openclaw.path);
  expect(paginateConversationCatalog(catalog, { query: "cobalt orchard" }).items.map((item) => item.path))
    .toEqual([openclaw.path]);
  /* Only the first prompt carries this phrase, so the match proves the
     first-prompt column is searched and not just the title. */
  expect(paginateConversationCatalog(catalog, { query: "seedlings" }).items.map((item) => item.path))
    .toEqual([openclaw.path]);
  expect(catalogEntryToFileEntry(openclaw)).toMatchObject({
    engine: "openclaw",
    fmt: "openclaw",
    root: "openclaw-sessions",
  });
});

test("a pagination cursor is bound to its member and permission snapshot", () => {
  const catalog = Array.from({ length: 5 }, (_, index) => entry(index));
  const first = paginateConversationCatalog(catalog, { limit: 1, authorityScope: "member-a:workspace-a" });
  expect(() => paginateConversationCatalog([], { cursor: first.nextCursor, authorityScope: "member-b:workspace-b" })).toThrow(ExpiredConversationCatalogCursorError);
  expect(() => paginateConversationCatalog([], { cursor: first.nextCursor, authorityScope: "member-a:workspace-b" })).toThrow(ExpiredConversationCatalogCursorError);
  expect(() => paginateConversationCatalog([], { cursor: first.nextCursor })).toThrow(ExpiredConversationCatalogCursorError);
  expect(paginateConversationCatalog([], { cursor: first.nextCursor, authorityScope: "member-a:workspace-a" }).items).toHaveLength(4);
});

test("catalog pages retain Claude subagent paths and Codex thread metadata for chat nesting", () => {
  const subagent = catalogEntryToFileEntry({
    ...entry(1), engine: "claude", root: "claude-projects", fmt: "claude", kind: "subagent",
    name: "project/session/subagents/workflow/agent-task.jsonl",
    path: "/transcripts/project/session/subagents/workflow/agent-task.jsonl",
  });
  expect(subagent.parent).toBe("/transcripts/project/session.jsonl");

  const thread = "00000000-0000-0000-0000-000000000002";
  const parent = "00000000-0000-0000-0000-000000000001";
  const codex = catalogEntryToFileEntry({ ...entry(2), path: `/sessions/rollout-${thread}.jsonl`, nativeParentThreadId: parent });
  expect(codex).toMatchObject({ nativeThreadId: thread, nativeParentThreadId: parent });
});

test("chat pagination bounds large families and preserves every parent link across pages", () => {
  const parent = entry(1);
  const children = Array.from({ length: 2_000 }, (_, index) => ({ ...entry(index + 100), parent: parent.path }));
  const unrelated = entry(20);
  const otherProject = { ...entry(25, "other"), parent: parent.path };
  const options = { project: "viewer", tree: true, limit: 23 };
  let page = paginateConversationCatalog([...children, unrelated, parent, otherProject], options);
  expect(page.items[0]?.path).toBe(parent.path);
  expect(page.total).toBe(2_002);
  const paths: string[] = [];
  while (true) {
    expect(page.items.length).toBeLessThanOrEqual(options.limit);
    for (const row of page.items) {
      if (row.path !== parent.path && row.path !== unrelated.path) expect(row.parent).toBe(parent.path);
      paths.push(row.path);
    }
    if (!page.nextCursor) break;
    page = paginateConversationCatalog([], { ...options, cursor: page.nextCursor });
  }
  expect(paths.at(-1)).toBe(unrelated.path);
  expect(paths).toHaveLength(2_002);
  expect(new Set(paths).size).toBe(paths.length);
});

test("opening a branch that fits on one page keeps other active cursors", () => {
  const parent = entry(1);
  const child = { ...entry(2), parent: parent.path };
  const catalog = [parent, child, entry(3), entry(4)];
  const roots = { project: "viewer", tree: true, branch: { parent: null }, limit: 2 };
  const first = paginateConversationCatalog(catalog, roots);
  for (let index = 0; index < 15; index += 1) paginateConversationCatalog(catalog, roots);

  const children = paginateConversationCatalog(catalog, { ...roots, branch: { parent: parent.path } });
  expect(children.items.map(item => item.path)).toEqual([child.path]);
  expect(children.nextCursor).toBeNull();
  const second = paginateConversationCatalog([], { ...roots, cursor: first.nextCursor });
  expect(second.items.map(item => item.path)).toEqual([parent.path]);
});
