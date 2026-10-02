import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalProject, persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";

import { MemoryIndex } from "./index";

const roots: string[] = [];
const previousState = process.env.LLV_STATE_DIR;
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
    expect(index.offers(page.items[0].id)).toEqual([{ channel: "search", outcome: "opened", conversationId: "conversation-fixture" }]);
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
