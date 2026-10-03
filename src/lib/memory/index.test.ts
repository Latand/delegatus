import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { canonicalProject, persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";

import { MemoryIndex } from "./index";
import type { Candidate } from "./selection";

const roots: string[] = [];
const previousState = process.env.LLV_STATE_DIR;
test("a contended derivative never holds hook claims or ledger writes behind SQLite's default wait", async () => {
  const index = new MemoryIndex();
  await index.refresh([{ path: fixture("locked.md", "v1\n## User preferences\n- Widget parser requires escaped delimiter pairs.\n"), engine: "codex", sourceKind: "codex_summary" }]);
  const candidates = index.injectionCandidates("widget", "project-a", "claude", "locked-conversation").map(c => ({ ...c, score: .8 }));
  index.recordInjection(candidates, "original-turn", "locked-conversation");
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const run of [
      () => index.claimHook("locked-conversation", "new-turn"),
      () => index.recordInjection(candidates, "new-turn", "locked-conversation"),
      () => index.recordCitations("locked-conversation", "<oai-mem-citation>\nlocked.md:3-3|note=[widget rule]\n</oai-mem-citation>"),
    ]) {
      const start = performance.now();
      expect(run).toThrow();
      expect(performance.now() - start).toBeLessThan(500);
    }
  } finally { db.exec("ROLLBACK"); db.close(); index.close(); }
}, 20000);
test("large mirrored stores fail open within the candidate budget", () => {
  const index = new MemoryIndex();
  index.search({ query: "widget" });
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
  try {
    db.transaction(() => {
      for (let i = 0; i < 3000; i++) {
        const title = "Widget rule " + Array.from({ length: 15 }, (_, k) => `item${i}word${k}`).join(" ");
        const summary = Array.from({ length: 30 }, (_, k) => `item${i}summary${k}`).join(" ");
        const body = Array.from({ length: 50 }, (_, k) => `item${i}body${k}`).join(" ");
        for (const engine of ["codex", "claude"]) {
          const id = `${engine}-${i}`;
          db.query("INSERT INTO memory_entries VALUES (?, ?, 'preference', 'global', NULL, 'fixture.md', 'codex_summary', ?, ?, ?, '2026-10-01', '[]')").run(id, engine, title, summary, body);
          db.query("INSERT INTO memory_fts VALUES (?, ?, ?, ?)").run(id, title, summary, body);
        }
      }
    })();
    const start = performance.now();
    expect(index.injectionCandidates("Widget rules", "fixture-project", "codex", "fixture-conversation")).toEqual([]);
    expect(performance.now() - start).toBeLessThan(500);
    // An aborted scan must leave its prepared statements reusable.
    expect(index.injectionCandidates("Widget rules", "fixture-project", "codex", "fixture-conversation")).toEqual([]);
  } finally { db.close(); index.close(); }
}, 20000);
test("injection candidates exclude native near matches and foreign projects; opening updates the injection ledger", async () => {
  const index = new MemoryIndex();
  const note = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n---\n${description}\n`;
  try {
    await index.refresh([
      { path: fixture("cross.md", note("Widget cache", "Widget cache requires invalidation on every parser revision.")), engine: "claude", sourceKind: "claude_memory", project: "project-a" },
      { path: fixture("foreign.md", note("Widget remote", "Widget remote requires a dedicated socket.")), engine: "claude", sourceKind: "claude_memory", project: "project-b" },
      { path: fixture("duplicate.md", note("Widget encoding", "Widget encoding uses eight byte blocks for every record.")), engine: "claude", sourceKind: "claude_memory", project: "project-a" },
      { path: fixture("native.md", "v1\n## User preferences\n- Widget encoding uses eight byte blocks for every record.\n"), engine: "codex", sourceKind: "codex_summary" },
    ]);
    const candidates = index.injectionCandidates("widget", "project-a", "codex", "conversation-fixture");
    expect(candidates.map(c => c.title)).toEqual(["Widget cache"]);
    index.recordInjection(candidates.map(c => ({ ...c, score: .8 })), "turn-fixture", "conversation-fixture");
    index.recordInjection(candidates.map(c => ({ ...c, score: .8 })), "turn-fixture", "conversation-fixture");
    expect(index.offers(candidates[0].id)).toMatchObject([{ channel: "inject", score: .8 }]);
    expect(index.injectionCandidates("widget", "project-a", "codex", "conversation-fixture")).toEqual([]);
    index.open(candidates[0].id, "open-fixture", "conversation-fixture");
    expect(index.offers(candidates[0].id)[0].outcome).toBe("opened");
    index.recordCitations("conversation-fixture", `The identifier ${candidates[0].id} is available.`);
    expect(index.offers(candidates[0].id)[0].outcome).toBe("opened");
    index.recordCitations("conversation-fixture", "<oai-mem-citation>\n<citation_entries>\ncross.md:7-8|note=[cache rule]\n</citation_entries>\n</oai-mem-citation>");
    expect(index.offers(candidates[0].id)[0].outcome).toBe("cited");
    expect(index.turnOffers("conversation-fixture")).toMatchObject([{ requestId: "turn-fixture", title: "Widget cache" }]);
  } finally { index.close(); }
});
test("another project's native Claude note cannot suppress a global cross-engine offer", async () => {
  const index = new MemoryIndex();
  const summary = "Widget parser records require escaped delimiter pairs.";
  try {
    await index.refresh([
      { path: fixture("global.md", `v1\n## User preferences\n- ${summary}\n`), engine: "codex", sourceKind: "codex_summary" },
      { path: fixture("native-b.md", `---\nname: Widget parser\ndescription: ${summary}\nmetadata:\n  type: project\n---\n${summary}\n`), engine: "claude", sourceKind: "claude_memory", project: "project-b" },
    ]);
    expect(index.injectionCandidates("widget parser", "project-a", "claude", "conversation-a")).toHaveLength(1);
    expect(index.injectionCandidates("widget parser", "project-b", "claude", "conversation-b")).toHaveLength(0);
  } finally { index.close(); }
});
test("native FTS hits do not consume the thirty cross-engine candidate places", async () => {
  const index = new MemoryIndex();
  try {
    const native = Array.from({ length: 30 }, (_, i) => ({
      path: fixture(`native-${i}.md`, `---\nname: Widget\ndescription: Widget native clause number ${i}.\nmetadata:\n  type: project\n---\nNative widget clause ${i}.\n`),
      engine: "claude" as const, sourceKind: "claude_memory" as const, project: "project-a",
    }));
    await index.refresh([...native, { path: fixture("cross-candidate.md", "v1\n## User preferences\n- Widget delimiters require a quoted encoding policy for every parser.\n"), engine: "codex", sourceKind: "codex_summary" }]);
    expect(index.injectionCandidates("widget", "project-a", "claude", "candidate-fixture")).toHaveLength(1);
  } finally { index.close(); }
});
test("citation accounting stays inside the hook budget for a large source and long offer ledger", async () => {
  const index = new MemoryIndex();
  const source = fixture("bulk.md", "v1\n## User preferences\n" + Array.from({ length: 1000 }, (_, i) => `- Widget key${i} value${i} guard${i}.\n  ${(`filler${i} `).repeat(320)}\n`).join(""));
  try {
    await index.refresh([{ path: source, engine: "codex", sourceKind: "codex_summary" }]);
    // Seed a long existing ledger directly; candidate retrieval is separately
    // deadline-tested and may intentionally abstain under CPU contention.
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
    const entries = db.query<Candidate, []>("SELECT * FROM memory_entries ORDER BY id").all();
    db.close();
    for (let offset = 0; offset < entries.length; offset += 15)
      index.recordInjection(entries.slice(offset, offset + 15).map(c => ({ ...c, score: .8 })), `turn-${offset}`, "bulk-conversation");
    expect(index.turnOffers("bulk-conversation")).toHaveLength(1000);
    const block = "<oai-mem-citation>\n<citation_entries>\nbulk.md:3-3|note=[widget rule]\n</citation_entries>\n</oai-mem-citation>";
    const started = performance.now();
    index.recordCitations("bulk-conversation", block);
    expect(performance.now() - started).toBeLessThan(500);
    const first = index.search({ query: "key0", limit: 1 }).items[0];
    expect(index.offers(first.id)[0].outcome).toBe("cited");
  } finally { index.close(); }
}, 20000);
test("turn provenance retains the latest offers after the bounded ledger window fills", async () => {
  const index = new MemoryIndex();
  try {
    await index.refresh([{ path: fixture("offers.md", "v1\n## User preferences\n" + Array.from({ length: 1001 }, (_, i) => `- Widget offer key${i} requires delimiter verification.\n`).join("")), engine: "codex", sourceKind: "codex_summary" }]);
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
    let entries: Candidate[];
    try {
      entries = db.query<Candidate, []>("SELECT * FROM memory_entries ORDER BY id").all();
      db.transaction(() => {
        for (const entry of entries.slice(0, 1000))
          db.query("INSERT INTO memory_offers VALUES (?, ?, ?, ?, 'inject', ?, NULL, NULL)").run(entry.id, "older-turn", "offers-conversation", "2026-01-01T00:00:00.000Z", .8);
      })();
    } finally { db.close(); }
    index.recordInjection([{ ...entries[1000], score: .9 }], "latest-turn", "offers-conversation");
    const offers = index.turnOffers("offers-conversation");
    expect(offers).toHaveLength(1000);
    expect(offers.at(-1)).toMatchObject({ id: entries[1000].id, requestId: "latest-turn", score: .9 });
  } finally { index.close(); }
});
beforeEach(() => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "memory-state-"));
  roots.push(state);
  process.env.LLV_STATE_DIR = state;
  resetProjectAliasesForTests();
});

test("unchanged Codex memory follows a canonical project successor in search and open", async () => {
  const source = { path: fixture("MEMORY.md", "# Task Group: Widget cache\n### rollout_summary_files\n- example.md (cwd=/workspace/synthetic-widget)\n### Reusable knowledge\n- Widget cache holds eight entries.\n"), sourceKind: "codex_memory" as const, engine: "codex" as const };
  const index = new MemoryIndex();
  try {
    await index.refresh([source]);
    const original = index.search({ query: "widget" }).items[0];
    persistProjectAliases([{ source: original.project!, target: "project-successor", displayName: "Synthetic successor" }]);
    expect(await index.refresh([source])).toMatchObject({ filesRead: 0 });
    expect(index.search({ query: "widget", project: canonicalProject(original.project!) }).items).toHaveLength(1);
    expect(index.open(original.id, "successor-open", null, "project-successor")?.project).toBe("project-successor");
  } finally { index.close(); }
});

test("inserting and reordering bullet entries preserves IDs and their opened ledger across source kinds", async () => {
  const registryGroup = (title: string, fact: string) => `# Task Group: ${title}\n### rollout_summary_files\n- example.md (cwd=/workspace/widget)\n### Reusable knowledge\n- ${fact}\n`;
  const cases = [
    { sourceKind: "codex_memory" as const, engine: "codex" as const, before: registryGroup("Widget", "Widget cache holds eight entries."), after: registryGroup("Database", "Database locks are bounded.") + registryGroup("Widget", "Widget cache holds eight entries.") },
    { sourceKind: "codex_summary" as const, engine: "codex" as const, before: "v1\n## User preferences\n- Keep widget reports brief.\n", after: "v1\n## General Tips\n- Keep database locks bounded.\n## User preferences\n- Keep widget reports brief.\n" },
    { sourceKind: "rollout_summary" as const, engine: "codex" as const, before: "cwd: /workspace/widget\n# Rehearsal\n- Widget rehearsal passed.\n", after: "cwd: /workspace/widget\n# Rehearsal\n- Database rehearsal passed.\n- Widget rehearsal passed.\n" },
    { sourceKind: "claude_index" as const, engine: "claude" as const, project: "project-a", before: "- [Widget](widget.md)\n", after: "- [Database](database.md)\n- [Widget](widget.md)\n" },
  ];
  const index = new MemoryIndex();
  try {
    for (const [n, item] of cases.entries()) {
      const source = { path: fixture(`source-${n}.md`, item.before), sourceKind: item.sourceKind, engine: item.engine, project: item.project };
      await index.refresh([source]);
      const original = index.search({ query: "widget" }).items.find(hit => hit.sourcePath.endsWith(`source-${n}.md`))!;
      const oldBody = index.open(original.id, `original-${n}`, "conversation-fixture")!.body;
      fs.writeFileSync(source.path, item.after);
      await index.refresh([source]);
      expect(index.open(original.id, `new-${n}`, "conversation-fixture")?.body).toBe(oldBody);
      expect(index.offers(original.id)).toHaveLength(2);
    }
  } finally { index.close(); }
});
afterEach(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(name: string, content: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-fixture-"));
  roots.push(root);
  const filename = path.join(root, name);
  fs.writeFileSync(filename, content);
  return filename;
}

test("a Codex caller can find a Claude topic with its kind, project and source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-fixture-"));
  roots.push(root);
  const sourcePath = path.join(root, "memory", "widget.md");
  fs.mkdirSync(path.dirname(sourcePath));
  fs.writeFileSync(sourcePath, "---\nname: Widget cache\ndescription: Cache rules for widgets\nmetadata:\n  type: project\nmodified: 2026-10-01\n---\nUse a bounded widget cache.\n");
  const before = fs.statSync(sourcePath);
  const index = new MemoryIndex();
  try {
    expect(await index.refresh([{ path: sourcePath, sourceKind: "claude_memory", engine: "claude", project: "project-a" }])).toMatchObject({ filesRead: 1, entriesIndexed: 1 });
    expect(index.search({ query: "widget", project: "project-a" }).items).toMatchObject([
      { engine: "claude", kind: "project_fact", scope: "project", project: "project-a", sourcePath: sourcePath.replace(os.homedir() + path.sep, "$HOME/"), title: "Widget cache" },
    ]);
    expect(index.search({ query: "widget", project: "project-b" }).items).toEqual([]);
    expect(fs.statSync(sourcePath).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(sourcePath, "utf8")).toContain("Use a bounded widget cache.");
    expect(fs.readdirSync(path.dirname(sourcePath))).toEqual(["widget.md"]);
  } finally { index.close(); }
});

test("a Claude caller finds Codex bullets scoped by task source cwd and global summary preferences", async () => {
  const registry = fixture("MEMORY.md", "# Task Group: Widget maintenance\n\n## Task 1: Cache sizing\n### rollout_summary_files\n- rollout_summaries/example.md (cwd=/workspace/widget, updated_at=2026-10-01T10:00:00Z)\n### keywords\n- widget, cache\n### User preferences\n- Prefer small widget caches.\n### Reusable knowledge\n- Widget cache holds at most eight entries.\n### Failures and how to do differently\n- Unbounded widget caches exhaust memory.\n");
  const summary = fixture("memory_summary.md", "v1\n\n## User preferences\n- Keep widget reports concise.\n\n## What's in Memory\n### /workspace/other\n- Widget work belongs to the other project.\n");
  const index = new MemoryIndex();
  try {
    await index.refresh([
      { path: registry, engine: "codex", sourceKind: "codex_memory" },
      { path: summary, engine: "codex", sourceKind: "codex_summary" },
    ]);
    expect(index.search({ query: "widget", project: "project-a" }).items).toHaveLength(1);
    const all = index.search({ query: "widget" }).items;
    expect(all.map(item => item.kind).sort()).toEqual(["failure", "preference", "preference", "project_fact", "reference"]);
    expect(all.filter(item => item.scope === "project").every(item => item.project)).toBe(true);
    expect(index.search({ query: "widget", kind: "failure" }).items[0].summary).toContain("Unbounded");
  } finally { index.close(); }
});

test("all source kinds refresh incrementally, unknown formats fail closed and sources stay untouched", async () => {
  const sources = [
    { path: fixture("MEMORY.md", "# Memory\n- [Widget reference](widget.md): widget lookup\n"), sourceKind: "claude_index" as const, engine: "claude" as const, project: "project-a" },
    { path: fixture("rollout.md", "cwd: /workspace/widget\nupdated_at: 2026-10-01T10:00:00Z\n# Widget rehearsal\n- Widget socket rehearsal passed.\n"), sourceKind: "rollout_summary" as const, engine: "codex" as const },
    { path: fixture("AGENTS.md", "Keep widget reports concise."), sourceKind: "instruction" as const, engine: "codex" as const },
    { path: fixture("SKILL.md", "---\nname: widget-rule\ndescription: Widget single fact\n---\nUse widget port zero.\n"), sourceKind: "skill" as const, engine: "shared" as const },
    { path: fixture("unknown.md", "An unknown widget format."), sourceKind: "claude_memory" as const, engine: "claude" as const, project: "project-a" },
  ];
  const bytes = sources.map(source => fs.readFileSync(source.path));
  const times = sources.map(source => fs.statSync(source.path).mtimeMs);
  const index = new MemoryIndex();
  try {
    expect(await index.refresh(sources)).toMatchObject({ filesRead: 5, filesSkipped: 1, entriesIndexed: 4, filesFailed: 0 });
    expect(await index.refresh(sources)).toMatchObject({ filesRead: 0, filesSkipped: 5, entriesIndexed: 0 });
    expect(index.search({ query: "widget" }).items.map(item => item.sourceKind).sort()).toEqual(["claude_index", "instruction", "rollout_summary", "skill"]);
    sources.forEach((source, i) => {
      expect(fs.readFileSync(source.path)).toEqual(bytes[i]);
      expect(fs.statSync(source.path).mtimeMs).toBe(times[i]);
    });
    fs.writeFileSync(sources[2].path, "Keep gadget reports concise.");
    expect(await index.refresh(sources)).toMatchObject({ filesRead: 1, entriesIndexed: 1 });
    expect(index.search({ query: "gadget" }).items).toHaveLength(1);
    expect(index.search({ query: "widget", kind: "instruction" }).items).toHaveLength(0);
    index.close();
    expect(index.search({ query: "gadget" }).items).toHaveLength(1);
  } finally { index.close(); }
});

test("search is ranked and byte bounded; ingest redacts secrets and opening a hit records once", async () => {
  const secret = "sk-" + "synthetic".repeat(4);
  const sources = Array.from({ length: 35 }, (_, n) => ({
    path: fixture(`skill-${n}.md`, `---\nname: ${n === 0 ? "widget" : "other"}\ndescription: Widget rule ${n}\n---\nwidget ${secret} ${"界".repeat(3000)}\n`),
    sourceKind: "skill" as const, engine: "shared" as const,
  }));
  const index = new MemoryIndex();
  try {
    await index.refresh(sources);
    const page = index.search({ query: "widget", limit: 9999 });
    expect(page.items.length).toBeLessThanOrEqual(20);
    expect(page.items[0].title).toBe("widget");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16_000);
    expect(JSON.stringify(page)).not.toContain(secret);
    expect(page.items[0]).not.toHaveProperty("body");
    const opened = index.open(page.items[0].id, "open-once", "conversation-fixture");
    expect(opened?.body).toContain("[redacted]");
    expect(Buffer.byteLength(opened!.body)).toBeLessThanOrEqual(2048);
    index.open(page.items[0].id, "open-once", "conversation-fixture");
    expect(index.offers(page.items[0].id)).toEqual([{ channel: "search", score: null, outcome: "opened", conversationId: "conversation-fixture" }]);
    expect(index.open(page.items[0].id, "wrong-project", null, "project-b")).not.toBeNull(); // global skill
    const rawStore = fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite-wal"));
    expect(rawStore.includes(Buffer.from(secret))).toBe(false);
  } finally { index.close(); }
});

test("a complete refresh removes only absent sources and retains the ledger; incomplete scans retain entries", async () => {
  const source = { path: fixture("AGENTS.md", "Synthetic widget instructions."), engine: "codex" as const, sourceKind: "instruction" as const };
  const index = new MemoryIndex();
  try {
    await index.refresh([source]);
    const id = index.search({ query: "widget" }).items[0].id;
    index.open(id, "same-key", "conversation-a");
    index.open(id, "same-key", "conversation-b");
    expect(index.offers(id)).toHaveLength(2);
    await index.refresh([], { complete: false });
    expect(index.search({ query: "widget" }).items).toHaveLength(1);
    await index.refresh([source], { complete: true });
    expect(index.search({ query: "widget" }).items).toHaveLength(1);
    fs.unlinkSync(source.path);
    await index.refresh([], { complete: true });
    expect(index.search({ query: "widget" }).items).toHaveLength(0);
    expect(index.offers(id)).toHaveLength(2);
    expect(index.open(id, "gone", null)).toBeNull();
  } finally { index.close(); }
});

test("malformed and polluted Codex memory never becomes global memory", async () => {
  const sources = [
    { path: fixture("MEMORY.md", "# Task Group: Widget\n## Task 1: Widget\n### User preferences\n- Prefer widget caches.\n"), sourceKind: "codex_memory" as const, engine: "codex" as const },
    { path: fixture("rollout.md", "cwd: /workspace/widget\npolluted: true\n# Widget\n- Widget poisoned advice.\n"), sourceKind: "rollout_summary" as const, engine: "codex" as const },
  ];
  const index = new MemoryIndex();
  try {
    expect(await index.refresh(sources)).toMatchObject({ filesSkipped: 2, entriesIndexed: 0 });
    expect(index.search({ query: "widget" }).items).toEqual([]);
  } finally { index.close(); }
});

test("a previously indexed source that becomes oversized stops returning stale content", async () => {
  const source = { path: fixture("AGENTS.md", "Synthetic widget instructions."), engine: "codex" as const, sourceKind: "instruction" as const };
  const index = new MemoryIndex();
  try {
    await index.refresh([source]);
    expect(index.search({ query: "widget" }).items).toHaveLength(1);
    fs.writeFileSync(source.path, "x".repeat(4 * 1024 * 1024 + 1));
    expect(await index.refresh([source])).toMatchObject({ filesSkipped: 1 });
    expect(index.search({ query: "widget" }).items).toHaveLength(0);
  } finally { index.close(); }
});

test("an unobserved terminal delivery cannot suppress a later identical typed occurrence once its transcript row exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-native-cursor-"));
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const index = new MemoryIndex();
  try {
    const transcript = path.join(root, "synthetic.jsonl");
    fs.writeFileSync(transcript, "");
    index.recordTerminalDelivery("synthetic-delivery", "synthetic-conversation", "Repeat synthetic input", "agent", transcript);
    fs.appendFileSync(transcript, JSON.stringify({ type: "user", uuid: "synthetic-earlier", message: { role: "user", content: "Repeat synthetic input" } }) + "\n");
    expect(index.terminalOrigin("synthetic-conversation", "native:synthetic-next", "Repeat synthetic input", transcript, "claude")).toBeNull();
  } finally {
    index.close();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
