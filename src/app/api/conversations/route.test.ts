import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { NextRequest } from "next/server";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { viewerMcpBindings } from "@/lib/mcp/bindings";
import { beginDeputy, DEPUTY_HISTORY_CAP, endDeputy, readDeputies, recordDeputyFork } from "@/lib/orchestrator/deputies";
import { replaceConversationCatalog } from "@/lib/scanner/conversationCatalog";
import { resetFilesRouteCacheForTests, setFileCatalogMembershipProbeForTests } from "@/lib/scanner/scanCache";
import { projectForCwd } from "@/lib/scanner/describe";
import { indexTranscriptSources } from "@/lib/search/transcriptSearch";
import { writeSessionTitle } from "@/lib/session/titleStore";

import { GET } from "./route";
import { GET as pullRequests } from "./pull-requests/route";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-conversations-route-"));
const previousStateDir = process.env.LLV_STATE_DIR;
let registry: AgentRegistry;

beforeEach(() => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => null);
  process.env.LLV_STATE_DIR = sandbox;
  registry = new AgentRegistry(path.join(sandbox, "registry.json"));
  setAgentRegistryForTests(registry);
});
afterEach(() => {
  setFileCatalogMembershipProbeForTests(null);
  replaceConversationCatalog([]);
  setAgentRegistryForTests(null);
  fs.rmSync(path.join(sandbox, "session-titles.json"), { force: true, recursive: true });
  fs.rmSync(path.join(sandbox, "registry.json"), { force: true });
});
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("search lazily covers the first prompt of a cataloged Claude subagent", async () => {
  const transcript = path.join(sandbox, "agent-child.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "Investigate cobalt orchard" } }) + "\n");
  const stat = fs.statSync(transcript);
  replaceConversationCatalog([{
    path: transcript,
    root: "claude-projects",
    name: "agent-child.jsonl",
    project: "quiet-project",
    title: "Child agent",
    firstPrompt: "",
    engine: "claude",
    kind: "subagent",
    fmt: "claude",
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
  }]);

  const response = await GET(new Request("http://127.0.0.1/api/conversations?q=cobalt%20orchard"));
  const body = await response.json() as { items: Array<{ path: string }> };

  expect(response.status).toBe(200);
  expect(body.items.map((item) => item.path)).toEqual([transcript]);
});

test("search lazily covers a Codex prompt behind an early generated title", async () => {
  const transcript = path.join(sandbox, "codex-titled.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "ai-title", aiTitle: "Readable catalog title" }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Investigate amber orchard" } }),
  ].join("\n") + "\n");
  const stat = fs.statSync(transcript);
  replaceConversationCatalog([{
    path: transcript,
    root: "codex-sessions",
    name: "codex-titled.jsonl",
    project: "quiet-project",
    title: "Readable catalog title",
    firstPrompt: "",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
  }]);

  const response = await GET(new Request("http://127.0.0.1/api/conversations?q=amber%20orchard"));
  const body = await response.json() as { items: Array<{ path: string }> };

  expect(response.status).toBe(200);
  expect(body.items.map((item) => item.path)).toEqual([transcript]);
});

test("search finds a capped-out conversation by its custom title", async () => {
  const transcript = path.join(sandbox, "custom-title.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "Raw scanner title" } }) + "\n");
  const stat = fs.statSync(transcript);
  replaceConversationCatalog([{
    path: transcript,
    root: "claude-projects",
    name: "custom-title.jsonl",
    project: "quiet-project",
    title: "Raw scanner title",
    firstPrompt: "Raw scanner title",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
  }]);
  const key = `path:${transcript}`;
  writeSessionTitle([key], key, "Renamed amber orchard", undefined, "2026-07-13T00:00:00.000Z");

  const response = await GET(new Request("http://127.0.0.1/api/conversations?q=renamed%20amber"));
  const body = await response.json() as { items: Array<{ path: string; title: string }> };

  expect(response.status).toBe(200);
  expect(body.items).toEqual([expect.objectContaining({ path: transcript, title: "Renamed amber orchard" })]);
});

test("search finds a capped-out conversation by its registry launch title", async () => {
  const transcript = path.join(sandbox, "launch-title.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "Raw scanner title" } }) + "\n");
  const stat = fs.statSync(transcript);
  replaceConversationCatalog([{
    path: transcript,
    root: "claude-projects",
    name: "launch-title.jsonl",
    project: "quiet-project",
    title: "Raw scanner title",
    firstPrompt: "Raw scanner title",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
  }]);
  registry.reconcileConversations([{
    engine: "claude",
    path: transcript,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: sandbox, title: "Launch amber orchard", project: "launch-project" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T00:00:00.000Z",
  }]);

  const response = await GET(new Request("http://127.0.0.1/api/conversations?q=launch%20amber"));
  const body = await response.json() as { items: Array<{ path: string; title: string; project: string }> };

  expect(response.status).toBe(200);
  expect(body.items).toEqual([expect.objectContaining({
    path: transcript,
    title: "Launch amber orchard",
    project: projectForCwd(sandbox),
  })]);
});

test("an empty-query project list uses the registry launch cwd", async () => {
  const transcript = path.join(sandbox, "launch-project.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "Launch project prompt" } }) + "\n");
  const stat = fs.statSync(transcript);
  replaceConversationCatalog([{
    path: transcript,
    root: "claude-projects",
    name: "launch-project.jsonl",
    project: "scanner-project",
    title: "Scanner title",
    firstPrompt: "",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
  }]);
  registry.reconcileConversations([{
    engine: "claude",
    path: transcript,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: sandbox, title: "Launch title", project: "launch-project" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T00:00:00.000Z",
  }]);

  const canonicalProject = projectForCwd(sandbox)!;
  const response = await GET(new Request(`http://127.0.0.1/api/conversations?project=${encodeURIComponent(canonicalProject)}`));
  const body = await response.json() as { items: Array<{ path: string; title: string; project: string }> };

  expect(response.status).toBe(200);
  expect(body.items).toEqual([expect.objectContaining({
    path: transcript,
    title: "Launch title",
    project: canonicalProject,
  })]);
});

test("a primitive JSON line in one transcript does not break global search", async () => {
  const malformed = path.join(sandbox, "primitive.jsonl");
  const target = path.join(sandbox, "search-target.jsonl");
  fs.writeFileSync(malformed, "null\n42\n");
  fs.writeFileSync(target, JSON.stringify({ type: "user", message: { content: "Find violet orchard" } }) + "\n");
  const malformedStat = fs.statSync(malformed);
  const targetStat = fs.statSync(target);
  replaceConversationCatalog([
    {
      path: malformed,
      root: "claude-projects",
      name: "primitive.jsonl",
      project: "quiet-project",
      title: "Primitive transcript",
      firstPrompt: "",
      engine: "claude",
      kind: "session",
      fmt: "claude",
      mtime: malformedStat.mtimeMs / 1000,
      size: malformedStat.size,
    },
    {
      path: target,
      root: "claude-projects",
      name: "search-target.jsonl",
      project: "quiet-project",
      title: "Search target",
      firstPrompt: "",
      engine: "claude",
      kind: "session",
      fmt: "claude",
      mtime: targetStat.mtimeMs / 1000,
      size: targetStat.size,
    },
  ]);

  const response = await GET(new Request("http://127.0.0.1/api/conversations?q=violet%20orchard"));
  const body = await response.json() as { items: Array<{ path: string }> };

  expect(response.status).toBe(200);
  expect(body.items.map((item) => item.path)).toEqual([target]);
});

test("a just-written transcript surfaces as recent, not idle, in the route rows (#1038 review)", async () => {
  const transcript = path.join(sandbox, "live-row.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "still talking" } }) + "\n");
  const stat = fs.statSync(transcript);
  replaceConversationCatalog([{
    path: transcript,
    root: "claude-projects",
    name: "live-row.jsonl",
    project: "quiet-project",
    title: "Live row",
    firstPrompt: "",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
  }]);

  const response = await GET(new Request("http://127.0.0.1/api/conversations?project=quiet-project"));
  const body = await response.json() as { items: Array<{ path: string; activity: string }> };

  expect(response.status).toBe(200);
  expect(body.items[0]?.path).toBe(transcript);
  expect(body.items[0]?.activity).toBe("recent");
});

test("query results keep the registry-overlaid durable conversation id (#1040 review)", async () => {
  const transcript = path.join(sandbox, "durable-id.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "durable cinnabar quay" } }) + "\n");
  const stat = fs.statSync(transcript);
  replaceConversationCatalog([{
    path: transcript,
    root: "claude-projects",
    name: "durable-id.jsonl",
    project: "quiet-project",
    title: "Durable id row",
    firstPrompt: "durable cinnabar quay",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
  }]);
  registry.reconcileConversations([{
    engine: "claude",
    path: transcript,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: sandbox, title: "Durable id row", project: "launch-project" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T00:00:00.000Z",
  }]);

  const unfiltered = await GET(new Request("http://127.0.0.1/api/conversations?project=" + encodeURIComponent(projectForCwd(sandbox) ?? "")));
  const unfilteredBody = await unfiltered.json() as { items: Array<{ path: string; conversationId: string | null }> };
  const filtered = await GET(new Request("http://127.0.0.1/api/conversations?q=cinnabar%20quay"));
  const filteredBody = await filtered.json() as { items: Array<{ path: string; conversationId: string | null }> };

  expect(filtered.status).toBe(200);
  const unfilteredRow = unfilteredBody.items.find((item) => item.path === transcript);
  const filteredRow = filteredBody.items.find((item) => item.path === transcript);
  expect(unfilteredRow?.conversationId).toStartWith("conversation_");
  expect(filteredRow?.conversationId ?? null).toEqual(unfilteredRow?.conversationId ?? null);
});

test("project list rows carry the lineage the files response projects: a superseded round and an archived predecessor say so (#1671)", async () => {
  /* Invented session ids, assembled from parts so no literal id sits here. */
  const sessionId = (digit: string) => [digit.repeat(8), digit.repeat(4), `4${digit.repeat(3)}`, `8${digit.repeat(3)}`, digit.repeat(12)].join("-");
  const transcript = (name: string) => {
    const pathname = path.join(sandbox, `${name}.jsonl`);
    fs.writeFileSync(pathname, JSON.stringify({ type: "user", message: { content: name } }) + "\n");
    return pathname;
  };
  const firstRound = transcript(`round-${sessionId("1")}`);
  const secondRound = transcript(`round-${sessionId("2")}`);
  const moved = transcript(`moved-${sessionId("3")}`);
  const target = transcript(`target-${sessionId("4")}`);
  replaceConversationCatalog([firstRound, secondRound, moved, target].map((pathname) => {
    const stat = fs.statSync(pathname);
    return {
      path: pathname,
      root: "codex-sessions" as const,
      name: path.basename(pathname),
      project: "lineage-project",
      title: path.basename(pathname, ".jsonl"),
      firstPrompt: "",
      engine: "codex" as const,
      kind: "session",
      fmt: "codex" as const,
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
    };
  }));

  /* A retried round: the first is superseded by the second. */
  const first = registry.ensureConversation("codex", firstRound, null);
  const second = registry.ensureConversation("codex", secondRound, null);
  registry.recordSupersedence(first.id, second.id, "stage-retry");
  /* A conversation moved to another account: its first generation is archived. */
  const moving = registry.ensureConversation("codex", moved, "source");
  registry.setConversationMigration(moving.id, {
    intentId: "catalog-lineage",
    phase: "verifying",
    targetId: "target",
    revision: 1,
    error: null,
    operationId: "catalog-lineage-operation",
    providerReceipt: {
      operationId: "catalog-lineage-operation",
      nativeId: sessionId("4"),
      path: target,
      continuityPaths: [],
      historyHash: "catalog-lineage-history",
      host: { kind: "codex-app-server", identity: sessionId("4"), epoch: 1, verifiedAt: "2026-07-20T12:00:00.000Z" },
    },
    updatedAt: "2026-07-10T12:00:00.000Z",
  });
  registry.commitSuccessor(moving.id, { id: sessionId("4"), path: target, accountId: "target" }, 1,
    registry.conversation(moving.id)!.migration!.operationId, registry.conversation(moving.id)!.migration!.providerReceipt!);

  const response = await GET(new Request("http://127.0.0.1/api/conversations?project=lineage-project"));
  const body = await response.json() as { items: Array<{ path: string; migratedTo?: string; supersededBy?: { conversationId: string; path: string | null; at: string; reason: string; tailConversationId?: string; tailPath?: string | null } }> };
  const byPath = new Map(body.items.map((item) => [item.path, item]));

  expect(response.status).toBe(200);
  expect([...byPath.keys()].sort()).toEqual([firstRound, secondRound, moved, target].sort());
  const superseded = byPath.get(firstRound)?.supersededBy;
  expect(superseded).toEqual({ conversationId: second.id, path: secondRound, at: expect.any(String), reason: "stage-retry", tailConversationId: second.id, tailPath: secondRound });
  expect(byPath.get(secondRound)?.supersededBy).toBeUndefined();
  expect(byPath.get(moved)?.migratedTo).toBe(target);
  expect(byPath.get(target)?.migratedTo).toBeUndefined();
});


test("project search never opens unrelated transcript bodies", async () => {
  const selected = path.join(sandbox, "selected.jsonl");
  fs.writeFileSync(selected, JSON.stringify({ type: "user", message: { content: "Scoped keyword" } }) + "\n");
  const stat = fs.statSync(selected);
  const entry = { path: selected, root: "claude-projects" as const, name: "selected", project: "selected-project", title: "Selected", firstPrompt: "", engine: "claude" as const, kind: "session", fmt: "claude" as const, mtime: stat.mtimeMs / 1000, size: stat.size };
  // Reading this directory as a transcript throws; metadata-only projection is safe.
  replaceConversationCatalog([entry, { ...entry, path: sandbox, project: "other-project" }]);
  const result = await GET(new Request("http://localhost/api/conversations?project=selected-project&q=keyword"));
  expect((await result.json()).items.map((item: { path: string }) => item.path)).toEqual([selected]);
});

test("warm search beyond the old text-cache ceiling never reopens retained transcript heads", async () => {
  const entries = Array.from({ length: 2051 }, (_, n) => {
    const pathname = path.join(sandbox, `retained-${n}.jsonl`);
    fs.writeFileSync(pathname, JSON.stringify({ type: "user", message: { content: "Retained orchard" } }) + "\n");
    const stat = fs.statSync(pathname);
    return { path: pathname, root: "claude-projects" as const, name: `${n}`, project: "retained-project", title: "Unhydrated", firstPrompt: "", engine: "claude" as const, kind: "session", fmt: "claude" as const, mtime: stat.mtimeMs / 1000, size: stat.size };
  });
  replaceConversationCatalog(entries);
  const url = "http://localhost/api/conversations?project=retained-project&q=orchard&limit=5";
  const first = await (await GET(new Request(url))).json();
  expect(first.total).toBe(entries.length);
  // A directory is safe to stat but would fail a transcript-head read. Keep
  // the published snapshot unchanged, as it stays between discovery passes.
  const last = entries.at(-1)!.path;
  const saved = `${last}.saved`;
  fs.renameSync(last, saved);
  fs.mkdirSync(last);
  try {
    const second = await (await GET(new Request(url))).json();
    expect(second.total).toBe(entries.length);
    expect(second.items.map((item: { path: string }) => item.path)).toEqual(first.items.map((item: { path: string }) => item.path));
    const next = await (await GET(new Request(`${url}&cursor=${second.nextCursor}`))).json();
    expect(next.items).toHaveLength(5);
  } finally {
    fs.rmdirSync(last);
    fs.renameSync(saved, last);
  }
});

test("main chats and each branch have separate cursors and stable child totals", async () => {
  const project = "branch-fixture";
  const codexThread = (suffix: number) => ["0".repeat(8), "0".repeat(4), "4000", "8000", String(suffix).padStart(12, "0")].join("-");
  const codexParent = codexThread(10);
  const codexChild = codexThread(11);
  const make = (name: string, mtime: number, extra: Partial<Parameters<typeof replaceConversationCatalog>[0][number]> = {}) => {
    const pathname = path.join(sandbox, name + ".jsonl");
    fs.writeFileSync(pathname, "{}\n");
    return {
      path: pathname, name: name + ".jsonl", root: "claude-projects" as const,
      project, title: name, firstPrompt: "", engine: "claude" as const,
      kind: "session", fmt: "claude" as const, mtime, size: 3, ...extra,
    };
  };
  const main = make("main", 1);
  const one = make("recent-branch", 10, { parent: main.path });
  const two = make("older-branch", 2, { parent: main.path });
  const nested = make("nested-branch", 3, { parent: one.path });
  const codex = { engine: "codex", root: "codex-sessions", fmt: "codex" } as const;
  const thread = make(`rollout-${codexParent}`, 4, codex);
  const fork = make(`rollout-${codexChild}`, 6, { ...codex, nativeForkSourceThreadId: codexParent });
  replaceConversationCatalog([main, one, two, nested, thread, fork, make("out-of-project", 12, { parent: main.path, project: "other" })]);
  const base = `http://127.0.0.1/api/conversations?project=${project}&view=tree&limit=1`;
  const roots = `${base}&branch=roots`;
  const children = (parent: string) => `${base}&branch=children&parent=${encodeURIComponent(parent)}`;
  const json = async (url: string) => (await GET(new Request(url))).json();
  const firstRoot = await json(roots);
  expect(firstRoot).toMatchObject({ items: [{ path: main.path, parent: null, directChildCount: 2 }], total: 2, projectTotal: 6 });
  const firstChild = await json(children(main.path));
  expect(firstChild).toMatchObject({ items: [{ path: one.path, parent: main.path, directChildCount: 1 }], total: 2, projectTotal: 6 });
  const rootCursor = `&cursor=${firstRoot.nextCursor}`;
  const childCursor = `&cursor=${firstChild.nextCursor}`;
  expect((await GET(new Request(children(main.path) + rootCursor))).status).toBe(409);
  expect((await GET(new Request(children(thread.path) + childCursor))).status).toBe(409);
  expect(await json(roots + rootCursor)).toMatchObject({ items: [{ path: thread.path, engine: "codex", directChildCount: 1 }], nextCursor: null });
  expect(await json(children(main.path) + childCursor)).toMatchObject({ items: [{ path: two.path, directChildCount: 0 }], nextCursor: null });
  expect(await json(children(thread.path))).toMatchObject({ items: [{ path: fork.path, parent: thread.path, engine: "codex" }], total: 1 });
  expect(await json(children(one.path))).toMatchObject({ items: [{ path: nested.path, parent: one.path }], total: 1 });
  expect(await json(children("/absent/example.jsonl"))).toMatchObject({ items: [], nextCursor: null, total: 0 });
});

test("desktop branch lists keep cross-project Codex subagents under their native parent", async () => {
  const parentId = randomUUID();
  const make = (id: string, project: string, nativeParentThreadId?: string) => {
    const pathname = path.join(sandbox, `rollout-${id}.jsonl`);
    fs.writeFileSync(pathname, "{}\n");
    return {
      path: pathname, name: path.basename(pathname), root: "codex-sessions" as const,
      project, title: id, firstPrompt: "", engine: "codex" as const,
      kind: "session", fmt: "codex" as const, mtime: 1, size: 3, nativeParentThreadId,
    };
  };
  const parent = make(parentId, "parent-project");
  const child = make(randomUUID(), "child-project", parentId);
  const orphan = make(randomUUID(), "child-project", randomUUID());
  replaceConversationCatalog([parent, child, orphan]);
  const page = async (project: string, parent?: string) => {
    const query = new URLSearchParams({ project, view: "tree", branch: parent ? "children" : "roots" });
    if (parent) query.set("parent", parent);
    return (await GET(new Request(`http://127.0.0.1/api/conversations?${query}`))).json();
  };
  expect(await page("parent-project")).toMatchObject({ total: 1, items: [{ path: parent.path, directChildCount: 1 }] });
  expect(await page("parent-project", parent.path)).toMatchObject({
    total: 1, items: [{ path: child.path, project: "child-project", parent: parent.path }],
  });
  expect(await page("child-project")).toMatchObject({ total: 1, items: [{ path: orphan.path }] });
  expect(await page("child-project", parent.path)).toMatchObject({ total: 0, items: [] });
});

test("ordinary cursor pages still hydrate their own transcript titles", async () => {
  const entries = [1, 2].map(n => {
    const pathname = path.join(sandbox, `cursor-${n}.jsonl`);
    fs.writeFileSync(pathname, JSON.stringify({ type: "user", message: { content: `Actual title ${n}` } }) + "\n");
    const stat = fs.statSync(pathname);
    return { path: pathname, root: "claude-projects" as const, name: `cursor-${n}`, project: "cursor-project", title: "Unhydrated", firstPrompt: "", engine: "claude" as const, kind: "session", fmt: "claude" as const, mtime: 3 - n, size: stat.size };
  });
  replaceConversationCatalog(entries);
  const first = await (await GET(new Request("http://localhost/api/conversations?project=cursor-project&limit=1"))).json();
  const second = await (await GET(new Request(`http://localhost/api/conversations?project=cursor-project&limit=1&cursor=${first.nextCursor}`))).json();
  expect(first.items[0].title).toBe("Actual title 1");
  expect(second.items[0].title).toBe("Actual title 2");
});

test("the orchestrator's parallel selves leave no row in the page or in list_conversations", async () => {
  const transcript = (name: string) => {
    const pathname = path.join(sandbox, `${name}.jsonl`);
    fs.writeFileSync(pathname, JSON.stringify({ type: "user", message: { content: `Words of ${name}` } }) + "\n");
    return pathname;
  };
  const seat = transcript("seat");
  const byPath = transcript("ghost-by-path");
  const byId = transcript("ghost-by-id");
  replaceConversationCatalog([seat, byPath, byId].map((pathname) => {
    const stat = fs.statSync(pathname);
    return {
      path: pathname,
      root: "claude-projects" as const,
      name: path.basename(pathname),
      project: "ghost-project",
      title: "Orchestrator · parallel self",
      firstPrompt: "",
      engine: "claude" as const,
      kind: "session",
      fmt: "claude" as const,
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
    };
  }));
  /* One record names its transcript by the path the catalog holds; the other
     by an address the catalog does not, so only its conversation id joins. */
  const ghost = registry.ensureConversation("claude", byId, null);
  const record = (clientRequestId: string, deputyConversationId: string, artifactPath: string) => {
    const begun = beginDeputy({ project: "ghost-project", seatConversationId: "conversation_seat", seatEpoch: 1, seatPath: seat, clientRequestId, ask: { text: "file a task", images: 0, sender: null } });
    if (begun.kind !== "begun") throw new Error("deputy did not begin");
    recordDeputyFork(begun.deputy.askId, { deputyConversationId, artifactPath, forkRecordCount: 1 });
    endDeputy(begun.deputy.askId, { outcome: "done" });
  };
  try {
    record("ask-1", "conversation_ghost_a", byPath);
    record("ask-2", ghost.id, path.join(sandbox, "elsewhere", "ghost-by-id.jsonl"));

    const page = await (await GET(new Request("http://127.0.0.1/api/conversations?project=ghost-project"))).json() as { items: Array<{ path: string }>; total: number };
    expect(page.items.map((item) => item.path)).toEqual([seat]);
    expect(page.total).toBe(1);
    const search = await (await GET(new Request("http://127.0.0.1/api/conversations?project=ghost-project&q=words"))).json() as { items: Array<{ path: string }> };
    expect(search.items.map((item) => item.path)).toEqual([seat]);

    const tools = viewerMcpBindings(undefined, {
      get: async (pathname: string) => await (await GET(new Request(`http://127.0.0.1${pathname}`))).json() as Record<string, unknown>,
      post: async () => ({}),
    });
    const listed = await tools.list_conversations({ project: "ghost-project" }) as { conversations: Array<{ transcriptPath: string; conversationId: string | null }> };
    expect(listed.conversations.map((row) => row.transcriptPath)).toEqual([seat]);
    expect(listed.conversations.some((row) => row.conversationId === ghost.id)).toBe(false);
  } finally {
    fs.rmSync(path.join(sandbox, "orchestrator-deputies.json"), { force: true });
  }
});

test("a parallel self stays out of the page after the history cap trims its record", async () => {
  const transcript = (name: string) => {
    const pathname = path.join(sandbox, `${name}.jsonl`);
    fs.writeFileSync(pathname, JSON.stringify({ type: "user", message: { content: `Words of ${name}` } }) + "\n");
    return pathname;
  };
  const seat = transcript("capped-seat");
  const oldest = transcript("capped-ghost-0");
  replaceConversationCatalog([seat, oldest].map((pathname) => {
    const stat = fs.statSync(pathname);
    return {
      path: pathname,
      root: "claude-projects" as const,
      name: path.basename(pathname),
      project: "capped-project",
      title: "Orchestrator · parallel self",
      firstPrompt: "",
      engine: "claude" as const,
      kind: "session",
      fmt: "claude" as const,
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
    };
  }));
  try {
    for (let index = 0; index <= DEPUTY_HISTORY_CAP; index += 1) {
      const begun = beginDeputy({ project: "capped-project", seatConversationId: "conversation_seat", seatEpoch: 1, seatPath: seat, clientRequestId: `capped-${index}`, ask: { text: "file a task", images: 0, sender: null } });
      if (begun.kind !== "begun") throw new Error("deputy did not begin");
      recordDeputyFork(begun.deputy.askId, {
        deputyConversationId: `conversation_capped_${index}`,
        artifactPath: index === 0 ? oldest : path.join(sandbox, "elsewhere", `capped-${index}.jsonl`),
        forkRecordCount: 1,
      });
      endDeputy(begun.deputy.askId, { outcome: "done" });
    }
    expect(readDeputies().some((deputy) => deputy.artifactPath === oldest)).toBe(false);
    const page = await (await GET(new Request("http://127.0.0.1/api/conversations?project=capped-project"))).json() as { items: Array<{ path: string }> };
    expect(page.items.map((item) => item.path)).toEqual([seat]);
  } finally {
    fs.rmSync(path.join(sandbox, "orchestrator-deputies.json"), { force: true });
  }
});

test("chat PR lookup is scoped to cataloged transcripts in the selected project", async () => {
  const make = (project: string, number: number) => {
    const file = path.join(sandbox, `chat-pr-${number}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: "user", message: { content: `Review https://github.com/sample/reports/pull/${number}` } }) + "\n");
    const stat = fs.statSync(file);
    return { path: file, project, root: "claude-projects" as const, name: path.basename(file), title: "Review reports",
      firstPrompt: "", engine: "claude" as const, kind: "session", fmt: "claude" as const, size: stat.size, mtime: stat.mtimeMs / 1000 };
  };
  const allowed = make("reports-a", 7);
  const elsewhere = make("reports-b", 9);
  const unknown = make("reports-a", 11);
  replaceConversationCatalog([allowed, elsewhere]);
  await indexTranscriptSources([allowed, elsewhere, unknown].map(row => ({ ...row, mtimeMs: row.mtime * 1000 })));
  const query = new URLSearchParams({ project: "reports-a" });
  for (const row of [allowed, elsewhere, unknown]) query.append("transcript", row.path);
  const req = new NextRequest(`http://localhost/api/conversations/pull-requests?${query}`, { headers: { host: "localhost" } });
  const response = await pullRequests(req);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ [allowed.path]: {
    partial: false, items: [{ repository: "sample/reports", number: 7, url: "https://github.com/sample/reports/pull/7", state: null }],
  } });
});

test("chat PR history uses Claude attachments outside the indexed message window", async () => {
  const priorHome = process.env.LLV_CLAUDE_HOME;
  process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
  try {
    const projects = path.join(process.env.LLV_CLAUDE_HOME, "projects", "reports");
    fs.mkdirSync(projects, { recursive: true });
    const file = path.join(projects, "native-history.jsonl");
    const attach = (number: number) => JSON.stringify({
      type: "pr-link", prNumber: number, prUrl: `https://github.com/sample/reports/pull/${number}`,
    });
    fs.writeFileSync(file, [
      attach(7), attach(11),
      JSON.stringify({ type: "user", message: { content: "Compare https://github.com/sample/reports/pull/9" } }),
      attach(7), JSON.stringify({ type: "pr-link", prUrl: "https://example.test/reports/pull/1" }),
    ].join("\n") + "\n");
    const stat = fs.statSync(file);
    const row = { path: file, project: "reports", root: "claude-projects" as const, name: path.basename(file),
      title: "Review reports", firstPrompt: "", engine: "claude" as const, kind: "session", fmt: "claude" as const,
      size: stat.size, mtime: stat.mtimeMs / 1000 };
    replaceConversationCatalog([row]);
    await indexTranscriptSources([{ ...row, mtimeMs: stat.mtimeMs }]);
    const url = new URL("http://localhost/api/conversations/pull-requests");
    url.search = new URLSearchParams({ project: row.project, transcript: file }).toString();
    const read = async () => {
      const response = await pullRequests(new NextRequest(url, { headers: { host: "localhost" } }));
      return (await response.json())[file];
    };
    expect(await read()).toMatchObject({ partial: false, items: [{ number: 7 }, { number: 11 }] });
    fs.appendFileSync(file, attach(13) + "\n");
    expect(await read()).toMatchObject({ partial: false, items: [{ number: 13 }, { number: 7 }, { number: 11 }] });
  } finally {
    if (priorHome === undefined) delete process.env.LLV_CLAUDE_HOME;
    else process.env.LLV_CLAUDE_HOME = priorHome;
  }
});
