import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { replaceConversationCatalog } from "@/lib/scanner/conversationCatalog";
import { projectForCwd } from "@/lib/scanner/describe";
import { writeSessionTitle } from "@/lib/session/titleStore";

import { GET } from "./route";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-conversations-route-"));
const previousStateDir = process.env.LLV_STATE_DIR;
let registry: AgentRegistry;

beforeEach(() => {
  process.env.LLV_STATE_DIR = sandbox;
  registry = new AgentRegistry(path.join(sandbox, "registry.json"));
  setAgentRegistryForTests(registry);
});
afterEach(() => {
  replaceConversationCatalog([]);
  setAgentRegistryForTests(null);
  fs.rmSync(path.join(sandbox, "session-titles.json"), { force: true });
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
