import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { canonicalProject, persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { directoryProjectId, localRepositoryProjectId } from "@/lib/projects/identity";
import { GET as memorySearch, POST as memoryOpen } from "@/app/api/search/memory/route";
import { memoryIndex } from "./service";
import { injectMemory } from "./injection";

import { MemoryIndex } from "./index";
import type { Candidate } from "./selection";
import { discoverMemorySources } from "./sources";
import { projectInfoFromCwd } from "@/lib/scanner/describe";

const roots: string[] = [];
const previousState = process.env.LLV_STATE_DIR;
test("one thousand worktree hook lookups retain bounded root scope and readable search", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-many-worktrees-")); roots.push(root);
  fs.mkdirSync(path.join(root, ".git")); fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/fixture/widgets.git\n');
  const project = projectInfoFromCwd(root)!.project;
  try {
    await index.refresh([{ path: fixture("topic.md", "---\nname: Widget rule\ndescription: Widget delimiter rule.\ntype: project\n---\nWidget delimiter rule.\n"), engine: "claude", sourceKind: "claude_memory", project: directoryProjectId(root) }]);
    for (let i = 0; i < 1000; i++) {
      const cwd = path.join(root, "worktrees", `lane-${i}`); fs.mkdirSync(cwd, { recursive: true });
      expect(projectInfoFromCwd(cwd)?.project).toBe(project);
      const start = performance.now();
      expect(await index.injectionCandidates("widget", project, "claude", `worktree-${i}`, Infinity, { cwd })).toHaveLength(1);
      expect(performance.now() - start).toBeLessThan(100);
    }
    expect((await index.search({ query: "widget", project })).items).toHaveLength(1);
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
    try { expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM memory_project_scopes").get()!.count).toBeLessThanOrEqual(3); }
    finally { db.close(); }
  } finally { index.close(); }
}, 30_000);
test("a full scope table refuses new historical ownership and still selects canonical entries", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-scope-capacity-")); roots.push(root);
  fs.mkdirSync(path.join(root, ".git")); fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/fixture/widgets.git\n');
  const project = projectInfoFromCwd(root)!.project;
  await index.refresh(["current", "previous"].map(name => ({
    path: fixture(`${name}.md`, `---\nname: Widget ${name}\ndescription: Widget ${name} delimiter rule.\ntype: project\n---\nWidget ${name} delimiter rule.\n`),
    engine: "claude" as const, sourceKind: "claude_memory" as const, project: name === "current" ? project : directoryProjectId(root),
  })));
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
  try {
    db.transaction(() => { for (let i = 0; i < 256; i++) db.query("INSERT INTO memory_project_scopes VALUES (?, ?, ?, NULL)").run(`synthetic-scope-${i}`, `other-${i}`, Number.MAX_SAFE_INTEGER); })();
    const candidates = await index.injectionCandidates("widget", project, "claude", "scope-capacity", Infinity, { cwd: root });
    expect(candidates.map(item => item.title)).toEqual(["Widget current"]);
    expect((await index.search({ query: "widget", project })).items.map(item => item.title)).toEqual(["Widget current"]);
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM memory_project_scopes").get()!.count).toBe(256);
  } finally { db.close(); index.close(); }
});
test("a resolved shared-store project wins over an earlier unresolved account slug", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-shared-scope-")); roots.push(root);
  const shared = path.join(root, "shared"); fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, "MEMORY.md"), "- [Widget](topic.md) — Widget delimiter rule.\n");
  fs.writeFileSync(path.join(shared, "topic.md"), "---\nname: Widget rule\ndescription: Widget delimiter rule.\ntype: project\n---\nWidget delimiter rule.\n");
  const homes = [path.join(root, "legacy-home"), path.join(root, "current-home")];
  for (const [home, slug] of [[homes[0], "legacy"], [homes[1], "current"]]) {
    fs.mkdirSync(path.join(home, "projects", slug), { recursive: true });
    fs.symlinkSync(shared, path.join(home, "projects", slug, "memory"));
  }
  try {
    for (const order of [homes, [...homes].reverse()]) {
      const found = await discoverMemorySources({ claudeHomes: order, codexHome: path.join(root, "absent"), skillRoots: [], projectForSlug: slug => slug === "current" ? "project-a" : slug });
      expect(found.complete).toBe(true); expect(found.sources).toHaveLength(2);
      expect(found.sources.map(source => source.project)).toEqual(["project-a", "project-a"]);
      await index.refresh(found.sources);
      for (const engine of ["claude", "codex"] as const) {
        const candidates = await index.injectionCandidates("widget", "project-a", engine, `shared-${engine}`);
        expect(candidates).toHaveLength(1);
        const topic = (await index.search({ query: "widget", project: "project-a" })).items.find(item => item.sourceKind === "claude_memory");
        expect(topic).toBeDefined(); expect(candidates[0].id).toBe(topic!.id);
      }
    }
  } finally { index.close(); }
});

test("one linked-root scan verifies physical predecessor identity before the first recall", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-linked-first-")); roots.push(root);
  const physical = path.join(root, "physical"), linked = path.join(root, "linked");
  fs.mkdirSync(path.join(physical, ".git"), { recursive: true }); fs.writeFileSync(path.join(physical, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(physical, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/fixture/widgets.git\n'); fs.symlinkSync(physical, linked);
  // Only the logical cwd has been scanned; recall must perform no git reads.
  const project = projectInfoFromCwd(linked)!.project;
  try {
    await index.refresh([{ path: fixture("topic.md", "---\nname: Widget linked rule\ndescription: Widget linked delimiter rule.\ntype: project\n---\nWidget linked delimiter rule.\n"), engine: "claude", sourceKind: "claude_memory", project: localRepositoryProjectId(physical, true)! }]);
    expect(await index.injectionCandidates("widget", project, "claude", "linked-first", Infinity, { cwd: linked })).toHaveLength(1);
  } finally { index.close(); }
});

test("verified unbound folder identities advance to their first origin and reject a later unrelated origin", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-first-origin-")); roots.push(root);
  const cwd = path.join(root, "project"); fs.mkdirSync(cwd);
  const source = { path: fixture("topic.md", "---\nname: Widget prior rule\ndescription: Widget prior delimiter rule.\ntype: project\n---\nWidget prior delimiter rule.\n"), engine: "claude" as const, sourceKind: "claude_memory" as const, project: directoryProjectId(cwd) };
  const recall = async (phase: string) => {
    const project = projectInfoFromCwd(cwd, phase)!.project;
    return { project, candidates: await index.injectionCandidates("widget", project, "claude", phase, Infinity, { cwd }) };
  };
  try {
    await index.refresh([source]); expect((await recall("directory")).candidates).toHaveLength(1);
    fs.mkdirSync(path.join(cwd, ".git")); fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(cwd, ".git", "config"), "[core]\nrepositoryformatversion = 0\n");
    expect((await recall("local")).candidates).toHaveLength(1);
    const remote = (name: string) => fs.writeFileSync(path.join(cwd, ".git", "config"), `[remote "origin"]\nurl = https://example.invalid/fixture/${name}.git\n`);
    remote("first"); const first = await recall("first-origin"); expect(first.candidates).toHaveLength(1);
    index.close(); expect((await index.search({ query: "widget", project: first.project })).items).toHaveLength(1);
    remote("unrelated"); const other = await recall("unrelated-origin"); expect(other.project).not.toBe(first.project); expect(other.candidates).toEqual([]);
    expect((await index.search({ query: "widget", project: other.project })).items).toEqual([]);
    expect(await index.open(first.candidates[0].id, "unrelated-first", null, other.project)).toBeNull();
  } finally { index.close(); }
});

test("retargeting a cached cwd symlink cannot confer foreign predecessor ownership", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-cwd-retarget-")); roots.push(root);
  const firstRoot = path.join(root, "first"), secondRoot = path.join(root, "second"), linked = path.join(root, "linked");
  for (const [folder, name] of [[firstRoot, "first"], [secondRoot, "unrelated"]]) {
    fs.mkdirSync(path.join(folder, ".git"), { recursive: true }); fs.writeFileSync(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(folder, ".git", "config"), `[remote "origin"]\nurl = https://example.invalid/fixture/${name}.git\n`);
  }
  fs.symlinkSync(firstRoot, linked);
  const first = projectInfoFromCwd(linked)!.project, second = projectInfoFromCwd(secondRoot)!.project;
  expect(first).not.toBe(second);
  const foreignKey = localRepositoryProjectId(secondRoot, true)!;
  try {
    await index.refresh([{ path: fixture("foreign.md", "---\nname: Widget foreign rule\ndescription: Widget foreign delimiter rule.\ntype: project\n---\nWidget foreign delimiter rule.\n"), engine: "claude", sourceKind: "claude_memory", project: foreignKey }]);
    fs.unlinkSync(linked); fs.symlinkSync(secondRoot, linked);
    expect(await index.injectionCandidates("widget", first, "claude", "retarget", Infinity, { cwd: linked })).toEqual([]);
    index.close();
    expect((await index.search({ query: "widget", project: first })).items).toEqual([]);
    const [foreign] = (await index.search({ query: "widget" })).items;
    expect(await index.open(foreign.id, "retarget-open", null, first)).toBeNull();
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
    try { expect(db.query("SELECT key FROM memory_project_scopes WHERE key = ?").get(foreignKey)).toBeNull(); } finally { db.close(); }
  } finally { index.close(); }
});

test("overlapping candidate calls keep a contended writer inside the retrieval budget", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-overlap-")); roots.push(root);
  fs.mkdirSync(path.join(root, ".git")); fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/fixture/widgets.git\n');
  const project = projectInfoFromCwd(root)!.project;
  await index.refresh([{ path: fixture("topic.md", "---\nname: Widget rule\ndescription: Widget delimiter rule.\ntype: project\n---\nWidget delimiter rule.\n"), engine: "claude", sourceKind: "claude_memory", project: directoryProjectId(root) }]);
  let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
  const original = fs.promises.realpath; let calls = 0;
  const spy = spyOn(fs.promises, "realpath").mockImplementation((async (...args: Parameters<typeof fs.promises.realpath>) => {
    if (args[0] === root && ++calls === 2) await paused;
    return original(...args);
  }) as typeof fs.promises.realpath);
  const writer = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite")); let locked = false;
  try {
    const first = index.injectionCandidates("widget", project, "claude", "first-overlap", Infinity, { cwd: root });
    const second = index.injectionCandidates("widget", project, "claude", "second-overlap", Infinity, { cwd: root });
    expect(await first).toHaveLength(1);
    const searching = index.search({ query: "widget", project });
    writer.exec("BEGIN IMMEDIATE"); locked = true;
    const start = performance.now(); release();
    expect(await second).toHaveLength(1); expect(performance.now() - start).toBeLessThan(150);
    expect((await searching).items).toHaveLength(1); expect(performance.now() - start).toBeLessThan(150);
  } finally { release(); if (locked) writer.exec("ROLLBACK"); writer.close(); spy.mockRestore(); index.close(); }
}, 10_000);

test("a trusted absent root recovers all ninety-nine native history paths on unchanged refresh", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-root-history-")); roots.push(root);
  const current = path.join(root, "current"), old = path.join(root, "previous");
  fs.mkdirSync(path.join(current, ".git"), { recursive: true }); fs.writeFileSync(path.join(current, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(current, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/fixture/widgets.git\n');
  const project = projectInfoFromCwd(current)!.project;
  const siblings = Array.from({ length: 94 }, (_, i) => path.join(root, `previous-pipeline-${i}`));
  const nested = Array.from({ length: 4 }, (_, i) => path.join(old, "worktrees", `lane-${i}`));
  const foreign = path.join(root, "foreign-pipeline"), foreignRoot = path.join(root, "foreign");
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "worktree-map.json"), JSON.stringify(Object.fromEntries([...siblings.map(cwd => [cwd, { repo: old, worktree: path.basename(cwd) }]), [foreign, { repo: foreignRoot, worktree: "foreign" }]])));
  const sources = [old, ...siblings, ...nested, foreign].map((cwd, i) => ({ path: fixture(`rollout-${i}.md`, `cwd: ${cwd}\n# History ${i}\n- UniqueToken${i} requires ${i + 2} delimiters.\n`), engine: "codex" as const, sourceKind: "rollout_summary" as const }));
  try {
    await index.refresh(sources);
    for (const i of [0, 1, 95, 99]) expect(await index.injectionCandidates(`UniqueToken${i}`, project, "claude", `unlinked-${i}`, Infinity, { cwd: current })).toEqual([]);
    persistProjectAliases([{ source: directoryProjectId(old), target: project, displayName: "Widget recovered root" }]);
    const refreshed = await index.refresh(sources); expect(refreshed.filesRead).toBe(100);
    for (let i = 0; i < 99; i++) for (const engine of ["claude", "codex"]) {
      const candidates = await index.injectionCandidates(`UniqueToken${i}`, project, engine, `linked-${i}-${engine}`);
      expect(candidates).toHaveLength(1); expect(candidates[0].body).toContain(`UniqueToken${i} `);
    }
    expect(await index.injectionCandidates("UniqueToken99", project, "claude", "foreign-history")).toEqual([]);
    expect(projectInfoFromCwd(siblings[0])?.repo).toBe(old);
  } finally { index.close(); }
});

test("specific short factual copies deduplicate across descriptions and previous offers", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-short-fact-")); roots.push(root);
  const project = projectInfoFromCwd(root)!.project;
  try {
    await index.refresh([
      { path: fixture("topic.md", "---\nname: Runtime\ndescription: Pinned interpreter.\ntype: project\n---\nWidget uses Bun.\n"), engine: "claude", sourceKind: "claude_memory", project },
      { path: fixture("rollout.md", `cwd: ${root}\n# Widget\n- Widget uses Bun.\n`), engine: "codex", sourceKind: "rollout_summary" },
    ]);
    const candidates = await index.injectionCandidates("widget", project, "claude", "short-fact");
    expect(candidates).toHaveLength(1);
    index.recordInjection(candidates.map(item => ({ ...item, score: .9 })), "first-fact", "short-fact");
    expect(await index.injectionCandidates("widget", project, "claude", "short-fact")).toEqual([]);
  } finally { index.close(); }
});

test("a predecessor identity retains its first verified repository across origin replacement", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-origin-replace-")); roots.push(root);
  fs.mkdirSync(path.join(root, ".git")); fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const remote = (name: string) => fs.writeFileSync(path.join(root, ".git", "config"), `[remote "origin"]\nurl = https://example.invalid/fixture/${name}.git\n`);
  remote("first"); const first = projectInfoFromCwd(root, "first")!.project;
  try {
    await index.refresh([{ path: fixture("topic.md", "---\nname: Widget rule\ndescription: Widget delimiter rule.\ntype: project\n---\nWidget delimiter rule.\n"), engine: "claude", sourceKind: "claude_memory", project: directoryProjectId(root) }]);
    const [candidate] = await index.injectionCandidates("widget", first, "claude", "before-replace", Infinity, { cwd: root });
    expect(candidate).toBeDefined(); index.close();
    remote("unrelated"); const second = projectInfoFromCwd(root, "second")!.project; expect(second).not.toBe(first);
    expect(await index.injectionCandidates("widget", second, "claude", "after-replace", Infinity, { cwd: root })).toEqual([]);
    expect((await index.search({ query: "widget", project: second })).items).toEqual([]);
    expect(await index.open(candidate.id, "foreign-replace", null, second)).toBeNull();
    persistProjectAliases([{ source: first, target: second, displayName: "Widget verified rename" }]);
    expect(await index.injectionCandidates("widget", second, "claude", "trusted-rename", Infinity, { cwd: root })).toHaveLength(1);
  } finally { index.close(); }
});

for (const shape of ["directory", "local", "slug"]) test(`${shape} predecessor scope survives a fresh Viewer process`, async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-scope-restart-")); roots.push(root);
  fs.mkdirSync(path.join(root, ".git")); fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/fixture/widgets.git\n');
  const project = projectInfoFromCwd(root)!.project;
  const previous = shape === "directory" ? directoryProjectId(root) : shape === "local" ? localRepositoryProjectId(root)! : root.replace(/[^a-zA-Z0-9]/g, "-");
  try {
    await index.refresh([{ path: fixture("topic.md", "---\nname: Widget prior rule\ndescription: Widget prior delimiter rule.\ntype: project\n---\nWidget prior delimiter rule.\n"), engine: "claude", sourceKind: "claude_memory", project: previous }]);
    const [candidate] = await index.injectionCandidates("widget", project, "claude", "before-restart", Infinity, { cwd: root });
    expect(candidate).toBeDefined(); index.recordInjection([{ ...candidate, score: .9 }], "restart-offer", "before-restart");
    index.close();
    const child = Bun.spawn([process.execPath, "-e", `
      import { MemoryIndex } from ${JSON.stringify(path.resolve("src/lib/memory/index.ts"))};
      import { projectInfoFromCwd } from ${JSON.stringify(path.resolve("src/lib/scanner/describe.ts"))};
      projectInfoFromCwd(${JSON.stringify(root)});
      const index = new MemoryIndex();
      const found = await index.search({query:"widget", project:${JSON.stringify(project)}});
      const opened = await index.open(${JSON.stringify(candidate.id)},"after-restart",null,${JSON.stringify(project)});
      console.log(JSON.stringify({ids:found.items.map(item=>item.id), opened:opened?.id})); index.close();
    `], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).toBe(""); expect(code).toBe(0); expect(JSON.parse(out)).toEqual({ ids: [candidate.id], opened: candidate.id });
  } finally { index.close(); }
});

test("slow git metadata cannot block recall's cached identity evidence", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-metadata-")); roots.push(root);
  fs.mkdirSync(path.join(root, ".git")); fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/fixture/widgets.git\n');
  const project = projectInfoFromCwd(root, "verified-before-turn")!.project;
  await index.refresh([{ path: fixture("topic.md", "---\nname: Widget rule\ndescription: Widget delimiter rule.\ntype: project\n---\nWidget delimiter rule.\n"), engine: "claude", sourceKind: "claude_memory", project: directoryProjectId(root) }]);
  const original = fs.readFileSync; let metadataReads = 0;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === path.join(root, ".git", "config")) { metadataReads++; const until = performance.now() + 1700; while (performance.now() < until) { /* model stalled metadata */ } }
    return original(...args);
  }) as typeof fs.readFileSync);
  try {
    const start = performance.now();
    const block = await injectMemory({ prompt: "widget", context: [], project, engine: "claude", origin: "operator", conversation: "metadata-conversation", requestId: "metadata-turn" }, {
      enabled: () => true, ownsTraffic: () => true, candidates: deadline => index.injectionCandidates("widget", project, "claude", "metadata-conversation", deadline, { cwd: root }),
      reserve: () => true, settle: () => {}, record: () => {}, decide: async body => ({ cost: .001, scores: Object.fromEntries(Object.keys(body.questions).map(id => [id, .9])) }),
    });
    expect(performance.now() - start).toBeLessThan(150); expect(metadataReads).toBe(0); expect(block).toContain("Widget rule");
  } finally { spy.mockRestore(); index.close(); }
});

for (const shape of ["directory", "local", "slug"]) test(`${shape} predecessor recall stays searchable and opens through the project-scoped route`, async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-scoped-open-")); roots.push(root);
  fs.mkdirSync(path.join(root, ".git")); fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/fixture/widgets.git\n');
  const project = projectInfoFromCwd(root)!.project;
  const previous = shape === "directory" ? directoryProjectId(root) : shape === "local" ? localRepositoryProjectId(root)! : root.replace(/[^a-zA-Z0-9]/g, "-");
  try {
    await index.refresh([
      { path: fixture("topic.md", "---\nname: Widget former rule\ndescription: Widget former delimiter rule.\ntype: project\n---\nWidget former delimiter rule.\n"), engine: "claude", sourceKind: "claude_memory", project: previous },
      { path: fixture("foreign.md", "---\nname: Widget foreign rule\ndescription: Widget foreign delimiter rule.\ntype: project\n---\nWidget foreign delimiter rule.\n"), engine: "claude", sourceKind: "claude_memory", project: "project-b" },
    ]);
    const [candidate] = await index.injectionCandidates("widget", project, "claude", "scoped-open", Infinity, { cwd: root });
    expect(candidate).toBeDefined();
    // Directory signatures survive elapsed time without another slug walk.
    const now = Date.now;
    const clock = spyOn(Date, "now").mockImplementation(() => now() + 11_000);
    try {
      const search = await memorySearch(new Request(`http://localhost/api/search/memory?q=widget&project=${project}`));
      expect(search.status).toBe(200); expect((await search.json()).items.map((item: { id: string }) => item.id)).toEqual([candidate.id]);
      const open = await memoryOpen(new Request("http://localhost/api/search/memory", { method: "POST", body: JSON.stringify({ id: candidate.id, requestId: "scoped-open", conversationId: "scoped-open", project }) }));
      expect(open.status).toBe(200); expect((await open.json()).item.id).toBe(candidate.id);
      const foreign = (await index.search({ query: "foreign" })).items[0];
      const rejected = await memoryOpen(new Request("http://localhost/api/search/memory", { method: "POST", body: JSON.stringify({ id: foreign.id, requestId: "foreign-open", project }) }));
      expect(rejected.status).toBe(404);
    } finally { clock.mockRestore(); }
  } finally { index.close(); memoryIndex().close(); }
});

test("a fresh scoped access rejects a formerly unique slug after a foreign folder collides", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-scope-collision-")); roots.push(root);
  const folder = path.join(root, "team-repo"), foreign = path.join(root, "team", "repo");
  fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
  fs.writeFileSync(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(folder, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/fixture/widgets.git\n');
  const project = projectInfoFromCwd(folder)!.project;
  try {
    await index.refresh([{ path: fixture("topic.md", "---\nname: Widget rule\ndescription: Widget delimiter rule.\ntype: project\n---\nWidget delimiter rule.\n"), engine: "claude", sourceKind: "claude_memory", project: folder.replace(/[^a-zA-Z0-9]/g, "-") }]);
    const [candidate] = await index.injectionCandidates("widget", project, "claude", "before-collision", Infinity, { cwd: folder });
    expect(candidate).toBeDefined(); fs.mkdirSync(foreign, { recursive: true });
    expect(foreign.replace(/[^a-zA-Z0-9]/g, "-")).toBe(folder.replace(/[^a-zA-Z0-9]/g, "-"));
    expect((await index.search({ query: "widget", project })).items).toEqual([]);
    expect(await index.open(candidate.id, "collision-open", null, project)).toBeNull();
    expect(await index.injectionCandidates("widget", project, "claude", "after-collision", Infinity, { cwd: folder })).toEqual([]);
  } finally { index.close(); }
});

test("a previously offered pointer excludes its resolved topic and cross-engine copies", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-pointer-offer-")); roots.push(root);
  const project = projectInfoFromCwd(root)!.project;
  const pointer = { path: fixture("MEMORY.md", "- [Widget routing](topic.md) — Widget routing reference.\n", root), engine: "claude" as const, sourceKind: "claude_index" as const, project };
  try {
    await index.refresh([pointer]);
    const prior = await index.injectionCandidates("widget", project, "codex", "pointer-conversation");
    expect(prior).toHaveLength(1); index.recordInjection(prior.map(item => ({ ...item, score: .9 })), "pointer-offer", "pointer-conversation");
    const topic = { path: fixture("topic.md", "---\nname: Widget parser\ndescription: Widget parser needs paired delimiter escaping.\ntype: project\n---\nWidget parser needs paired delimiter escaping.\n", root), engine: "claude" as const, sourceKind: "claude_memory" as const, project };
    const copy = { path: fixture("rollout.md", `cwd: ${root}\n# Widget parser\n- Widget parser needs paired delimiter escaping.\n`, root), engine: "codex" as const, sourceKind: "rollout_summary" as const };
    await index.refresh([pointer, topic, copy]);
    for (const query of ["widget", "routing", "parser"]) expect(await index.injectionCandidates(query, project, "codex", "pointer-conversation")).toEqual([]);
    expect((await index.injectionCandidates("widget", project, "codex", "fresh-pointer-conversation")).map(item => item.title)).toEqual(["Widget parser"]);
  } finally { index.close(); }
});

test("a root index stays loaded when discovered first through nested file or directory symlinks", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-root-link-")); roots.push(root);
  const home = path.join(root, "claude"), directory = path.join(home, "projects", "fixture", "memory");
  fs.mkdirSync(path.join(directory, "archive"), { recursive: true });
  const filename = fixture("MEMORY.md", "- [Widget recovery](missing.md) — Widget recovery reference.\n", directory);
  fs.symlinkSync(filename, path.join(directory, "archive", "MEMORY.md"));
  fs.symlinkSync(filename, path.join(directory, "archive", "a-note.md"));
  fs.symlinkSync(directory, path.join(directory, "archive", "loop"));
  try {
    const discovery = await discoverMemorySources({ claudeHomes: [home], codexHome: path.join(root, "absent"), skillRoots: [], projectForSlug: () => "project-a" });
    expect(discovery.sources).toHaveLength(1);
    expect(discovery.sources[0]).toMatchObject({ sourceKind: "claude_index", loadedByDefault: true });
    await index.refresh(discovery.sources);
    expect(await index.injectionCandidates("widget", "project-a", "claude", "loaded-root-link")).toEqual([]);
    expect(await index.injectionCandidates("widget", "project-a", "codex", "cross-root-link")).toHaveLength(1);
  } finally { index.close(); }
});

test("a loaded store root is registered even when its directory was already visited through a nested link", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-directory-root-")); roots.push(root);
  const home = path.join(root, "claude"), projects = path.join(home, "projects");
  const shared = path.join(projects, "first", "memory", "shared");
  fs.mkdirSync(shared, { recursive: true });
  fixture("MEMORY.md", "- [Widget recovery](missing.md) — Widget recovery reference.\n", shared);
  fs.mkdirSync(path.join(projects, "second")); fs.symlinkSync(shared, path.join(projects, "second", "memory"));
  try {
    const discovery = await discoverMemorySources({ claudeHomes: [home], codexHome: path.join(root, "absent"), skillRoots: [], projectForSlug: () => "project-a" });
    expect(discovery.sources).toHaveLength(1); expect(discovery.sources[0].loadedByDefault).toBe(true);
    await index.refresh(discovery.sources);
    expect(await index.injectionCandidates("widget", "project-a", "claude", "directory-root")).toEqual([]);
  } finally { index.close(); }
});

test("a symlinked cwd retains verified physical-folder historical keys", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-physical-")); roots.push(root);
  const physical = path.join(root, "physical"), linked = path.join(root, "linked");
  fs.mkdirSync(path.join(physical, ".git"), { recursive: true });
  fs.writeFileSync(path.join(physical, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(physical, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/fixture/widgets.git\n');
  fs.symlinkSync(physical, linked);
  try {
    const project = projectInfoFromCwd(physical)!.project;
    expect(projectInfoFromCwd(linked)!.project).toBe(project);
    await index.refresh([{ path: fixture("topic.md", "---\nname: Widget physical rule\ndescription: Widget physical delimiter rule.\ntype: project\n---\nWidget physical delimiter rule.\n"), engine: "claude", sourceKind: "claude_memory", project: directoryProjectId(physical) }]);
    for (const cwd of [physical, linked]) expect(await index.injectionCandidates("widget", project, "claude", cwd, Infinity, { cwd })).toHaveLength(1);
  } finally { index.close(); }
});

test("identity proof avoids synchronous directory walks and bounds stalled asynchronous reads", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-proof-budget-")); roots.push(root);
  const folder = path.join(root, "widgets"); fs.mkdirSync(folder);
  const project = projectInfoFromCwd(folder)!.project;
  await index.refresh([{ path: fixture("topic.md", "---\nname: Widget rule\ndescription: Widget delimiter rule.\ntype: project\n---\nWidget delimiter rule.\n"), engine: "claude", sourceKind: "claude_memory", project: folder.replace(/[^a-zA-Z0-9]/g, "-") }]);
  const originalSync = fs.readdirSync, originalAsync = fs.promises.readdir;
  let blockingReads = 0;
  const sync = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
    if (args[0] === root) { blockingReads++; const until = performance.now() + 250; while (performance.now() < until) { /* simulate slow synchronous storage */ } }
    return originalSync(...args);
  }) as typeof fs.readdirSync);
  try {
    const start = performance.now();
    expect(await index.injectionCandidates("widget", project, "claude", "nonblocking-proof", Infinity, { cwd: folder })).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(150); expect(blockingReads).toBe(0);
    let stalledReads = 0;
    const asynchronous = spyOn(fs.promises, "readdir").mockImplementation(((...args: Parameters<typeof fs.promises.readdir>) => {
      if (args[0] !== root) return originalAsync(...args);
      stalledReads++; return new Promise(() => {});
    }) as typeof fs.promises.readdir);
    try {
      // An unchanged directory signature replays the proof without a walk.
      expect(await index.injectionCandidates("widget", project, "claude", "replayed-proof", Infinity, { cwd: folder })).toHaveLength(1);
      expect(stalledReads).toBe(0);
      const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
      try { db.query("DELETE FROM memory_project_scopes").run(); } finally { db.close(); }
      for (const remaining of [50, 1500]) {
        let reason = ""; const began = performance.now();
        expect(await index.injectionCandidates("widget", project, "claude", `stalled-${remaining}`, began + remaining, { cwd: folder, reason: value => { reason = value; } })).toEqual([]);
        expect(performance.now() - began).toBeLessThan(150); expect(reason).toBe("candidateTimeout");
      }
    } finally { asynchronous.mockRestore(); }
  } finally { sync.mockRestore(); index.close(); }
});

test("an ambiguous worktree-shaped Claude slug cannot inherit its parent's identity", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-worktree-collision-")); roots.push(root);
  const parent = path.join(root, "widgets");
  const folders = [parent, path.join(parent, ".worktrees", "lane"), path.join(root, "widgets..worktrees-lane")];
  for (const [i, folder] of folders.entries()) {
    fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
    fs.writeFileSync(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(folder, ".git", "config"), `[remote "origin"]\nurl = https://example.invalid/fixture/widgets${i}.git\n`);
  }
  const encode = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, "-");
  const slug = encode(folders[1]); expect(slug).toBe(encode(folders[2]));
  const home = path.join(root, "claude"), directory = path.join(home, "projects", slug, "memory");
  fs.mkdirSync(directory, { recursive: true });
  fixture("topic.md", "---\nname: Widget foreign rule\ndescription: Widget foreign deployment rule.\ntype: project\n---\nWidget foreign deployment rule.\n", directory);
  const options = { claudeHomes: [home], codexHome: path.join(root, "absent"), skillRoots: [] };
  try {
    const project = projectInfoFromCwd(parent)!.project;
    for (const trustedParent of [false, true]) {
      if (trustedParent) persistProjectAliases([{ source: encode(parent), target: project, displayName: "Widgets" }]);
      const discovery = await discoverMemorySources(options);
      expect(discovery.sources[0].project).toBe(slug);
      await index.refresh(discovery.sources);
      expect((await index.injectionCandidates("widget", project, "claude", `ambiguous-${trustedParent}`, Infinity, { cwd: parent }))).toEqual([]);
    }
  } finally { index.close(); }
});

test("a trusted parent alias restores recognized deleted Claude worktree memory", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-history-")); roots.push(root);
  const previous = path.join(root, "deleted-parent").replace(/[^a-zA-Z0-9]/g, "-");
  const home = path.join(root, "claude");
  const directory = path.join(home, "projects", previous + "--worktrees-lane", "memory");
  fs.mkdirSync(directory, { recursive: true });
  fixture("topic.md", "---\nname: Widget history\ndescription: Widget socket uses paired escaping.\ntype: project\n---\nWidget socket uses paired escaping.\n", directory);
  const options = { claudeHomes: [home], codexHome: path.join(root, "absent"), skillRoots: [] };
  try {
    await index.refresh((await discoverMemorySources(options)).sources);
    expect((await index.injectionCandidates("widget", "project-a", "codex", "unlinked"))).toEqual([]);
    persistProjectAliases([{ source: previous, target: "project-a", displayName: "Widgets" }]);
    const discovered = await discoverMemorySources(options);
    expect(discovered.sources[0].project).toBe("project-a");
    await index.refresh(discovered.sources);
    expect((await index.injectionCandidates("widget", "project-a", "codex", "trusted-history"))).toHaveLength(1);
  } finally { index.close(); }
});

test("symlinked topic pointers resolve to canonical indexed identities for both engines", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-linked-topic-")); roots.push(root);
  const home = path.join(root, "claude"), directory = path.join(home, "projects", "fixture", "memory");
  fs.mkdirSync(directory, { recursive: true });
  const topic = fixture("actual.md", "---\nname: Widget parser\ndescription: Widget parser delimiter policy.\ntype: project\n---\nWidget parser validates escaped fields.\n", root);
  fs.symlinkSync(topic, path.join(directory, "topic.md"));
  fixture("MEMORY.md", "- [Routing workaround](topic.md) — Widget routing reference.\n", directory);
  try {
    await index.refresh((await discoverMemorySources({ claudeHomes: [home], codexHome: path.join(root, "absent"), skillRoots: [], projectForSlug: () => "project-a" })).sources);
    for (const engine of ["claude", "codex"]) {
      expect((await index.injectionCandidates("widget", "project-a", engine, engine)).map(item => item.title)).toEqual(["Widget parser"]);
      expect((await index.injectionCandidates("routing", "project-a", engine, engine)).map(item => item.title)).toEqual(["Widget parser"]);
    }
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
    try {
      db.query("UPDATE memory_entries SET flags = '[\"retired\"]' WHERE sourcePath = ?").run(topic);
      expect((await index.injectionCandidates("routing", "project-a", "codex", "retired-linked-topic"))).toEqual([]);
      db.query("UPDATE memory_entries SET flags = '[]', project = 'project-b' WHERE sourcePath = ?").run(topic);
      expect((await index.injectionCandidates("routing", "project-a", "claude", "foreign-linked-topic"))).toEqual([]);
      expect((await index.injectionCandidates("routing", "project-a", "codex", "foreign-reference")).map(item => item.title)).toEqual(["Routing workaround"]);
    } finally { db.close(); }
  } finally { index.close(); }
});

test("a colliding unresolved Claude slug cannot admit another repository's memory", async () => {
  const index = new MemoryIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-collision-")); roots.push(root);
  const folders = [path.join(root, "team-repo"), path.join(root, "team", "repo")];
  for (const [i, folder] of folders.entries()) {
    fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
    fs.writeFileSync(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(folder, ".git", "config"), `[remote "origin"]\nurl = https://example.invalid/fixture/widgets${i}.git\n`);
  }
  const slug = folders[0].replace(/[^a-zA-Z0-9]/g, "-");
  expect(slug).toBe(folders[1].replace(/[^a-zA-Z0-9]/g, "-"));
  try {
    await index.refresh([{ path: fixture("foreign.md", "---\nname: Widget foreign\ndescription: Widget uses foreign deployment rules.\ntype: project\n---\nWidget uses foreign deployment rules.\n"), engine: "claude", sourceKind: "claude_memory", project: slug }]);
    const project = projectInfoFromCwd(folders[0])!.project;
    expect((await index.injectionCandidates("widget", project, "claude", "collision-turn", Infinity, { cwd: folders[0] }))).toEqual([]);
    persistProjectAliases([{ source: slug, target: project, displayName: "Synthetic widgets" }]);
    expect((await index.injectionCandidates("widget", project, "claude", "trusted-turn", Infinity, { cwd: folders[0] }))).toHaveLength(1);
  } finally { index.close(); }
});

for (const engine of ["claude", "codex"]) test(`${engine} registry keywords retain retrieval without duplicating a short rollout fact`, async () => {
  const index = new MemoryIndex();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-")); roots.push(store);
  try {
    await index.refresh([
      { path: fixture("MEMORY.md", `# Task Group: Widget\n### rollout_summary_files\n- rollout.md (cwd=${store})\n### keywords\n- compiler-runtime\n### Reusable knowledge\n- Widget uses Bun.\n`, store), engine: "codex", sourceKind: "codex_memory" },
      { path: fixture("rollout.md", `cwd: ${store}\n# Widget\n- Widget uses Bun.\n`, store), engine: "codex", sourceKind: "rollout_summary" },
    ]);
    const project = projectInfoFromCwd(store)!.project;
    const candidates = (await index.injectionCandidates("widget", project, engine, "registry-copy-turn"));
    expect(candidates).toHaveLength(1);
    const byKeyword = (await index.injectionCandidates("compiler", project, engine, "keywords-turn"));
    expect(byKeyword).toHaveLength(1);
    expect(byKeyword[0].body).toBe("Widget uses Bun.");
    index.recordInjection(candidates.map(c => ({ ...c, score: .9 })), "registry-copy-offer", "registry-copy-turn");
    expect((await index.injectionCandidates("widget", project, engine, "registry-copy-turn"))).toEqual([]);
  } finally { index.close(); }
});

test("one FTS match in a two-hundred-thousand-topic inventory stays inside the candidate budget", async () => {
  const index = new MemoryIndex(); (await index.search({ query: "widget" }));
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
  try {
    db.transaction(() => {
      db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i < 199999)
        INSERT INTO memory_entries SELECT 'noise-' || i, 'claude', 'project_fact', 'project', 'project-a', '/workspace/topics/topic-' || i || '.md', 'claude_memory', 'Unrelated topic', 'Unrelated inventory note.', 'Unrelated inventory note.', '2026-10-01', '[]' FROM n;
        INSERT INTO memory_fts SELECT id, title, summary, body FROM memory_entries;`);
      db.query("INSERT INTO memory_entries VALUES ('match', 'codex', 'reference', 'project', 'project-a', 'fixture.md', 'rollout_summary', 'Widget', 'Widget uses Bun.', 'Widget uses Bun.', '2026-10-01', '[]')").run();
      db.query("INSERT INTO memory_fts VALUES ('match', 'Widget', 'Widget uses Bun.', 'Widget uses Bun.')").run();
    })();
    const start = performance.now();
    expect((await index.injectionCandidates("widget", "project-a", "codex", "large-inventory-turn"))).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(100);
  } finally { db.close(); index.close(); }
}, 20000);

test("short exact cross-engine copies occupy one recall place and are offered once per conversation", async () => {
  const index = new MemoryIndex();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-")); roots.push(store);
  try {
    await index.refresh([
      { path: fixture("topic.md", "---\nname: Widget\ndescription: Widget uses paired escaping.\ntype: project\n---\nWidget uses paired escaping.\n", store), engine: "claude", sourceKind: "claude_memory", project: "project-a" },
      { path: fixture("rollout.md", `cwd: ${store}\n# Widget\n- Widget uses paired escaping.\n`, store), engine: "codex", sourceKind: "rollout_summary" },
    ]);
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
    try { db.query("UPDATE memory_entries SET project = 'project-a' WHERE engine = 'codex'").run(); }
    finally { db.close(); }
    const candidates = (await index.injectionCandidates("widget", "project-a", "claude", "short-copy-turn"));
    expect(candidates).toHaveLength(1);
    index.recordInjection(candidates.map(c => ({ ...c, score: .9 })), "short-copy-offer", "short-copy-turn");
    expect((await index.injectionCandidates("widget", "project-a", "claude", "short-copy-turn"))).toEqual([]);
  } finally { index.close(); }
});

test("recall excludes the recipient's loaded index and summary and prefers an indexed topic over its pointer", async () => {
  const index = new MemoryIndex();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-")); roots.push(store);
  try {
    await index.refresh([
      { path: fixture("MEMORY.md", "- [Widget routing](topic.md) — Widget routing reference.\n- [Widget fallback](missing.md) — Widget fallback reference.\n", store), engine: "claude", sourceKind: "claude_index", project: "project-a" },
      { path: fixture("topic.md", "---\nname: Widget parser\ndescription: Widget parser delimiter policy.\ntype: project\n---\nWidget parser validates escaped fields.\n", store), engine: "claude", sourceKind: "claude_memory", project: "project-a" },
      { path: fixture("memory_summary.md", "v1\n## User preferences\n- Widget reports use compact tables.\n"), engine: "codex", sourceKind: "codex_summary" },
    ]);
    const claude = (await index.injectionCandidates("widget", "project-a", "claude", "claude-turn"));
    expect(claude.map(c => c.title).sort()).toEqual(["User preferences", "Widget parser"]);
    const codex = (await index.injectionCandidates("widget", "project-a", "codex", "codex-turn"));
    expect(codex.map(c => c.title).sort()).toEqual(["Widget fallback", "Widget parser"]);
    // Pointer-only search terms still recall the topic, with one identity.
    expect((await index.injectionCandidates("routing", "project-a", "codex", "routing-turn")).map(c => c.title)).toEqual(["Widget parser"]);
    expect((await index.injectionCandidates("routing", "project-a", "claude", "own-routing-turn")).map(c => c.title)).toEqual(["Widget parser"]);
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
    try {
      db.query("UPDATE memory_entries SET flags = ? WHERE sourceKind = 'claude_index'").run('["retired"]');
      expect((await index.injectionCandidates("routing", "project-a", "codex", "retired-pointer-turn"))).toEqual([]);
      db.query("UPDATE memory_entries SET flags = '[]' WHERE sourceKind = 'claude_index'").run();
      db.query("UPDATE memory_entries SET flags = ? WHERE sourceKind = 'claude_memory'").run('["retired"]');
      expect((await index.injectionCandidates("widget", "project-a", "codex", "retired-turn")).map(c => c.title)).toEqual(["Widget fallback"]);
      db.query("UPDATE memory_entries SET project = 'project-b', flags = '[]' WHERE sourceKind = 'claude_memory'").run();
      expect((await index.injectionCandidates("widget", "project-a", "codex", "foreign-turn")).map(c => c.title).sort()).toEqual(["Widget fallback", "Widget routing"]);
    } finally { db.close(); }
  } finally { index.close(); }
});

test("Claude recall excludes the loaded root index and retains unloaded nested index references", async () => {
  const index = new MemoryIndex();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memory-home-")); roots.push(home);
  const memory = path.join(home, "projects", "fixture-project", "memory");
  fs.mkdirSync(path.join(memory, "archive"), { recursive: true });
  fs.writeFileSync(path.join(memory, "MEMORY.md"), "- [Widget archive](archive/MEMORY.md) — Widget root routing.\n");
  fs.writeFileSync(path.join(memory, "archive", "MEMORY.md"), "- [Widget recovery](missing.md) — Widget archive recovery.\n");
  try {
    const discovered = await discoverMemorySources({ claudeHomes: [home], codexHome: path.join(home, "absent-codex"), skillRoots: [], projectForSlug: () => "project-a" });
    await index.refresh(discovered.sources);
    expect((await index.injectionCandidates("widget", "project-a", "claude", "nested-index-turn")).map(c => c.title)).toEqual(["Widget recovery"]);
  } finally { index.close(); }
});

test("a store with 199 pointers and 198 indexed topics has no pointer/topic pairs in thirty-place pools", async () => {
  const index = new MemoryIndex();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-")); roots.push(store);
  try {
    const sources = Array.from({ length: 198 }, (_, i) => ({
      path: fixture(`topic-${i}.md`, `---\nname: Widget topic ${i}\ndescription: Widget parser category${i % 12} checks field${i}.\ntype: project\n---\nWidget parser category${i % 12} validates field${i}.\n`, store),
      engine: "claude" as const, sourceKind: "claude_memory" as const, project: "project-a",
    }));
    await index.refresh([...sources,
      { path: fixture("MEMORY.md", Array.from({ length: 199 }, (_, i) => `- [Widget pointer ${i}](topic-${i}.md) — Widget parser category${i % 12} reference.\n`).join(""), store), engine: "claude", sourceKind: "claude_index", project: "project-a" },
      { path: fixture("memory_summary.md", "v1\n## User preferences\n- Widget parser reports include compact tables.\n"), engine: "codex", sourceKind: "codex_summary" },
    ]);
    for (const engine of ["claude", "codex"]) for (let i = 0; i < 12; i++) {
      const candidates = (await index.injectionCandidates(`widget parser category${i}`, "project-a", engine, `${engine}-${i}`));
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.length).toBeLessThanOrEqual(30);
      expect(candidates.some(c => c.title.startsWith("Widget pointer") && c.title !== "Widget pointer 198")).toBe(false);
      if (engine === "claude") expect(candidates.some(c => c.title.startsWith("Widget pointer"))).toBe(false);
      else expect(candidates.some(c => c.title === "User preferences")).toBe(false);
    }
  } finally { index.close(); }
});

test("a contended derivative never holds hook claims or ledger writes behind SQLite's default wait", async () => {
  const index = new MemoryIndex();
  await index.refresh([{ path: fixture("locked.md", "v1\n## User preferences\n- Widget parser requires escaped delimiter pairs.\n"), engine: "codex", sourceKind: "codex_summary" }]);
  const candidates = (await index.injectionCandidates("widget", "project-a", "claude", "locked-conversation")).map(c => ({ ...c, score: .8 }));
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
test("large mirrored stores return bounded unique candidates within the candidate budget", async () => {
  const index = new MemoryIndex();
  (await index.search({ query: "widget" }));
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
  try {
    db.transaction(() => {
      for (let i = 0; i < 3000; i++) {
        const title = "Widget rule " + Array.from({ length: 15 }, (_, k) => `item${i}word${k}`).join(" ");
        const summary = Array.from({ length: 30 }, (_, k) => `item${i}summary${k}`).join(" ");
        const body = Array.from({ length: 50 }, (_, k) => `item${i}body${k}`).join(" ");
        for (const engine of ["codex", "claude"]) {
          const id = `${engine}-${i}`;
          db.query("INSERT INTO memory_entries VALUES (?, ?, 'preference', 'global', NULL, 'fixture.md', 'codex_memory', ?, ?, ?, '2026-10-01', '[]')").run(id, engine, title, summary, body);
          db.query("INSERT INTO memory_fts VALUES (?, ?, ?, ?)").run(id, title, summary, body);
        }
      }
    })();
    const start = performance.now();
    expect((await index.injectionCandidates("Widget rules", "fixture-project", "codex", "fixture-conversation"))).toHaveLength(30);
    expect(performance.now() - start).toBeLessThan(500);
    // An aborted scan must leave its prepared statements reusable.
    expect((await index.injectionCandidates("Widget rules", "fixture-project", "codex", "fixture-conversation"))).toHaveLength(30);
  } finally { db.close(); index.close(); }
}, 20000);
test("injection candidates deduplicate both engines and exclude foreign projects; opening updates the injection ledger", async () => {
  const index = new MemoryIndex();
  const note = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n---\n${description}\n`;
  try {
    await index.refresh([
      { path: fixture("cross.md", note("Widget cache", "Widget cache requires invalidation on every parser revision.")), engine: "claude", sourceKind: "claude_memory", project: "project-a" },
      { path: fixture("foreign.md", note("Widget remote", "Widget remote requires a dedicated socket.")), engine: "claude", sourceKind: "claude_memory", project: "project-b" },
      { path: fixture("duplicate.md", note("Widget encoding", "Widget encoding uses eight byte blocks for every record.")), engine: "claude", sourceKind: "claude_memory", project: "project-a" },
      { path: fixture("native.md", "v1\n## User preferences\n- Widget encoding uses eight byte blocks for every record.\n"), engine: "codex", sourceKind: "codex_summary" },
    ]);
    const candidates = (await index.injectionCandidates("widget", "project-a", "codex", "conversation-fixture"));
    expect(candidates.map(c => c.title)).toEqual(["Widget cache"]);
    index.recordInjection(candidates.map(c => ({ ...c, score: .8 })), "turn-fixture", "conversation-fixture");
    index.recordInjection(candidates.map(c => ({ ...c, score: .8 })), "turn-fixture", "conversation-fixture");
    expect(index.offers(candidates[0].id)).toMatchObject([{ channel: "inject", score: .8 }]);
    expect((await index.injectionCandidates("widget", "project-a", "codex", "conversation-fixture"))).toEqual([]);
    (await index.open(candidates[0].id, "open-fixture", "conversation-fixture"));
    expect(index.offers(candidates[0].id).find(offer => offer.channel === "inject")!.outcome).toBe("opened");
    index.recordCitations("conversation-fixture", `The identifier ${candidates[0].id} is available.`);
    expect(index.offers(candidates[0].id).find(offer => offer.channel === "inject")!.outcome).toBe("opened");
    index.recordCitations("conversation-fixture", "<oai-mem-citation>\n<citation_entries>\ncross.md:7-8|note=[cache rule]\n</citation_entries>\n</oai-mem-citation>");
    expect(index.offers(candidates[0].id).find(offer => offer.channel === "inject")!.outcome).toBe("cited");
    expect(index.turnOffers("conversation-fixture").map(offer => offer.title).sort()).toEqual(["Widget cache"]);
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
    expect((await index.injectionCandidates("widget parser", "project-a", "claude", "conversation-a"))).toHaveLength(1);
    expect((await index.injectionCandidates("widget parser", "project-b", "claude", "conversation-b"))).toHaveLength(1);
  } finally { index.close(); }
});
test("both engines compete for thirty bounded candidate places", async () => {
  const index = new MemoryIndex();
  try {
    const native = Array.from({ length: 30 }, (_, i) => ({
      path: fixture(`native-${i}.md`, `---\nname: Widget\ndescription: Widget native clause number ${i}.\nmetadata:\n  type: project\n---\nNative widget clause ${i}.\n`),
      engine: "claude" as const, sourceKind: "claude_memory" as const, project: "project-a",
    }));
    await index.refresh([...native, { path: fixture("cross-candidate.md", "v1\n## User preferences\n- Widget delimiters require a quoted encoding policy for every parser.\n"), engine: "codex", sourceKind: "codex_summary" }]);
    expect((await index.injectionCandidates("widget", "project-a", "claude", "candidate-fixture"))).toHaveLength(30);
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
    const first = (await index.search({ query: "key0", limit: 1 })).items[0];
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
    const original = (await index.search({ query: "widget" })).items[0];
    persistProjectAliases([{ source: original.project!, target: "project-successor", displayName: "Synthetic successor" }]);
    expect(await index.refresh([source])).toMatchObject({ filesRead: 1 });
    expect(await index.refresh([source])).toMatchObject({ filesRead: 0, filesSkipped: 1 });
    expect((await index.search({ query: "widget", project: canonicalProject(original.project!) })).items).toHaveLength(1);
    expect((await index.open(original.id, "successor-open", null, "project-successor"))?.project).toBe("project-successor");
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
      const original = (await index.search({ query: "widget" })).items.find(hit => hit.sourcePath.endsWith(`source-${n}.md`))!;
      const oldBody = (await index.open(original.id, `original-${n}`, "conversation-fixture"))!.body;
      fs.writeFileSync(source.path, item.after);
      await index.refresh([source]);
      expect((await index.open(original.id, `new-${n}`, "conversation-fixture"))?.body).toBe(oldBody);
      expect(index.offers(original.id)).toHaveLength(2);
    }
  } finally { index.close(); }
});
afterEach(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(name: string, content: string, directory?: string) {
  const root = directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "memory-fixture-"));
  if (!directory) roots.push(root);
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
    expect((await index.search({ query: "widget", project: "project-a" })).items).toMatchObject([
      { engine: "claude", kind: "project_fact", scope: "project", project: "project-a", sourcePath: sourcePath.replace(os.homedir() + path.sep, "$HOME/"), title: "Widget cache" },
    ]);
    expect((await index.search({ query: "widget", project: "project-b" })).items).toEqual([]);
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
    expect((await index.search({ query: "widget", project: "project-a" })).items).toHaveLength(1);
    const all = (await index.search({ query: "widget" })).items;
    expect(all.map(item => item.kind).sort()).toEqual(["failure", "preference", "preference", "project_fact", "reference"]);
    expect(all.filter(item => item.scope === "project").every(item => item.project)).toBe(true);
    expect((await index.search({ query: "widget", kind: "failure" })).items[0].summary).toContain("Unbounded");
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
    expect((await index.search({ query: "widget" })).items.map(item => item.sourceKind).sort()).toEqual(["claude_index", "instruction", "rollout_summary", "skill"]);
    sources.forEach((source, i) => {
      expect(fs.readFileSync(source.path)).toEqual(bytes[i]);
      expect(fs.statSync(source.path).mtimeMs).toBe(times[i]);
    });
    fs.writeFileSync(sources[2].path, "Keep gadget reports concise.");
    expect(await index.refresh(sources)).toMatchObject({ filesRead: 1, entriesIndexed: 1 });
    expect((await index.search({ query: "gadget" })).items).toHaveLength(1);
    expect((await index.search({ query: "widget", kind: "instruction" })).items).toHaveLength(0);
    index.close();
    expect((await index.search({ query: "gadget" })).items).toHaveLength(1);
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
    const page = (await index.search({ query: "widget", limit: 9999 }));
    expect(page.items.length).toBeLessThanOrEqual(20);
    expect(page.items[0].title).toBe("widget");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16_000);
    expect(JSON.stringify(page)).not.toContain(secret);
    expect(page.items[0]).not.toHaveProperty("body");
    const opened = (await index.open(page.items[0].id, "open-once", "conversation-fixture"));
    expect(opened?.body).toContain("[redacted]");
    expect(Buffer.byteLength(opened!.body)).toBeLessThanOrEqual(2048);
    (await index.open(page.items[0].id, "open-once", "conversation-fixture"));
    expect(index.offers(page.items[0].id)).toEqual([{ channel: "search", score: null, outcome: "opened", conversationId: "conversation-fixture" }]);
    expect((await index.open(page.items[0].id, "wrong-project", null, "project-b"))).not.toBeNull(); // global skill
    const rawStore = fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite-wal"));
    expect(rawStore.includes(Buffer.from(secret))).toBe(false);
  } finally { index.close(); }
});

test("a complete refresh removes only absent sources and retains the ledger; incomplete scans retain entries", async () => {
  const source = { path: fixture("AGENTS.md", "Synthetic widget instructions."), engine: "codex" as const, sourceKind: "instruction" as const };
  const index = new MemoryIndex();
  try {
    await index.refresh([source]);
    const id = (await index.search({ query: "widget" })).items[0].id;
    (await index.open(id, "same-key", "conversation-a"));
    (await index.open(id, "same-key", "conversation-b"));
    expect(index.offers(id)).toHaveLength(2);
    await index.refresh([], { complete: false });
    expect((await index.search({ query: "widget" })).items).toHaveLength(1);
    await index.refresh([source], { complete: true });
    expect((await index.search({ query: "widget" })).items).toHaveLength(1);
    fs.unlinkSync(source.path);
    await index.refresh([], { complete: true });
    expect((await index.search({ query: "widget" })).items).toHaveLength(0);
    expect(index.offers(id)).toHaveLength(2);
    expect((await index.open(id, "gone", null))).toBeNull();
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
    expect((await index.search({ query: "widget" })).items).toEqual([]);
  } finally { index.close(); }
});

test("a previously indexed source that becomes oversized stops returning stale content", async () => {
  const source = { path: fixture("AGENTS.md", "Synthetic widget instructions."), engine: "codex" as const, sourceKind: "instruction" as const };
  const index = new MemoryIndex();
  try {
    await index.refresh([source]);
    expect((await index.search({ query: "widget" })).items).toHaveLength(1);
    fs.writeFileSync(source.path, "x".repeat(4 * 1024 * 1024 + 1));
    expect(await index.refresh([source])).toMatchObject({ filesSkipped: 1 });
    expect((await index.search({ query: "widget" })).items).toHaveLength(0);
  } finally { index.close(); }
});

test("native text remains unknown until independent operator ownership is established", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-native-cursor-"));
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const index = new MemoryIndex();
  try {
    const transcript = path.join(root, "synthetic.jsonl");
    fs.writeFileSync(transcript, "");
    index.recordTerminalDelivery("synthetic-delivery", "synthetic-conversation", "Repeat synthetic input", "agent", transcript);
    fs.appendFileSync(transcript, JSON.stringify({ type: "user", uuid: "synthetic-queued", message: { role: "user", content: "Earlier queued input" } }) + "\n");
    index.close(); // Pending authorship survives an unrelated journal and reload.
    expect(index.terminalOrigin("synthetic-conversation", "native:synthetic-other", "Different typed input", transcript, "claude")).toBeNull();
    fs.appendFileSync(transcript, JSON.stringify({ type: "user", uuid: "synthetic-earlier", message: { role: "user", content: "Repeat synthetic input" } }) + "\n");
    expect(index.terminalOrigin("synthetic-conversation", "native:synthetic-next", "Repeat synthetic input", transcript, "claude")).toBe("unknown");
    expect(index.terminalOrigin("synthetic-conversation", "native:synthetic-earlier", "Repeat synthetic input", transcript, "claude")).toBe("unknown");
    expect(index.terminalOrigin("synthetic-conversation", "native:synthetic-next", "Repeat synthetic input", transcript, "claude")).toBe("unknown");
  } finally {
    index.close();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("injected names remain the offered names after source edits, removal and reload", async () => {
  const index = new MemoryIndex();
  const source = { path: fixture("historical.md", "---\nname: Widget parser\ndescription: Widget parser requires escaped delimiters.\nmetadata:\n  type: project\n---\nUse escaped delimiters.\n"), engine: "claude" as const, sourceKind: "claude_memory" as const, project: "project-a" };
  try {
    await index.refresh([source]);
    const candidates = (await index.injectionCandidates("widget parser", "project-a", "codex", "historical-conversation"));
    expect(candidates).toHaveLength(1);
    index.recordInjection(candidates.map(entry => ({ ...entry, score: .8 })), "historical-turn", "historical-conversation");
    index.close();
    // Existing releases have the eight-column ledger and no name snapshot.
    const legacy = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
    legacy.exec("DROP TABLE memory_injection_names"); legacy.close();
    fs.writeFileSync(source.path, "---\nname: Renamed widget parser\ndescription: Widget parser requires escaped delimiters.\nmetadata:\n  type: project\n---\nChanged parser reference.\n");
    await index.refresh([source]);
    index.close();
    expect(index.turnOffers("historical-conversation")).toMatchObject([{ title: "Widget parser", score: .8 }]);
    await index.refresh([], { complete: true });
    index.close();
    expect(index.turnOffers("historical-conversation")).toMatchObject([{ title: "Widget parser", score: .8 }]);
    expect(index.offers(candidates[0].id)).toHaveLength(1);
  } finally { index.close(); }
});


test("confirmed emissions survive contention and reload with exactly one original scored name", async () => {
  const index = new MemoryIndex();
  await index.refresh([{ path: fixture("confirmed.md", "v1\n## User preferences\n- Widget parser requires escaped delimiter pairs.\n"), engine: "codex", sourceKind: "codex_summary" }]);
  const entries = (await index.injectionCandidates("widget", "project-a", "claude", "confirmed-conversation")).map(entry => ({ ...entry, score: .8 }));
  expect(entries).toHaveLength(1);
  const writer = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
  writer.exec("BEGIN IMMEDIATE");
  try {
    index.recordConfirmedInjection(entries, "confirmed-turn", "confirmed-conversation");
    index.recordConfirmedInjection(entries, "confirmed-turn", "confirmed-conversation");
    expect(fs.readdirSync(path.join(process.env.LLV_STATE_DIR!, "memory-injection-pending"))).toHaveLength(1);
  } finally { writer.exec("ROLLBACK"); writer.close(); index.close(); }
  try {
    // Remove the source before replay: the durable evidence keeps the offer.
    await index.refresh([], { complete: true });
    expect(index.turnOffers("confirmed-conversation")).toMatchObject([{ title: entries[0].title, score: .8 }]);
    index.recordConfirmedInjection(entries.map(entry => ({ ...entry, title: "Later title" })), "confirmed-turn", "confirmed-conversation");
    index.close();
    expect(index.turnOffers("confirmed-conversation")).toMatchObject([{ title: entries[0].title, score: .8 }]);
    expect(index.turnOffers("confirmed-conversation")).toHaveLength(1);
    expect(fs.readdirSync(path.join(process.env.LLV_STATE_DIR!, "memory-injection-pending"))).toHaveLength(0);
  } finally { index.close(); }
});

test("a confirmed backlog drains in bounded batches after contention and reload", async () => {
  const index = new MemoryIndex(), conversation = "backlog-conversation";
  await index.refresh([{ path: fixture("backlog.md", "v1\n## User preferences\n- Widget parser requires escaped delimiter pairs.\n"), engine: "codex", sourceKind: "codex_summary" }]);
  expect((await index.injectionCandidates("widget", "project-a", "claude", conversation))).toHaveLength(1);
  const writer = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
  const pending = path.join(process.env.LLV_STATE_DIR!, "memory-injection-pending");
  writer.exec("BEGIN IMMEDIATE");
  try {
    for (let i = 0; i < 257; i++) {
      const hook = `backlog-hook-${i}`;
      index.recordPreparedInjection([{ id: `synthetic-${i}`, title: "Synthetic emitted memory", score: .8 }], `backlog-turn-${i}`, conversation, hook, Date.now() + 1500);
      index.confirmPreparedInjection(conversation, hook, Date.now());
    }
    expect(fs.readdirSync(pending)).toHaveLength(257);
  } finally { writer.exec("ROLLBACK"); writer.close(); index.close(); }
  try {
    // Retrieval drains one batch and abstains until every confirmation is
    // accounted for, so an unprocessed offer cannot be injected again.
    expect((await index.injectionCandidates("widget", "project-a", "claude", conversation))).toHaveLength(0);
    expect(fs.readdirSync(pending).length).toBeGreaterThan(0);
    expect(fs.readdirSync(pending).length).toBeLessThan(257);
    for (let i = 0; fs.readdirSync(pending).length && i < 257; i++) {
      const started = performance.now();
      expect(() => index.turnOffers(conversation)).not.toThrow();
      expect(performance.now() - started).toBeLessThan(500);
    }
    expect(fs.readdirSync(pending)).toHaveLength(0);
    const offers = index.turnOffers(conversation);
    expect(offers).toHaveLength(257);
    expect(new Set(offers.map(offer => offer.requestId)).size).toBe(257);
    index.recordConfirmedInjection([{ id: "synthetic-0", title: "Later title", score: .9 }], "backlog-turn-0", conversation);
    index.close();
    expect(index.turnOffers(conversation)).toHaveLength(257);
    expect(index.turnOffers(conversation).find(offer => offer.requestId === "backlog-turn-0")).toMatchObject({ title: "Synthetic emitted memory", score: .8 });
    expect((await index.injectionCandidates("widget", "project-a", "claude", conversation))).toHaveLength(1);
  } finally { index.close(); }
}, 30000);

test("cold hook bookkeeping fails open on contention and retries initialization after unlock", async () => {
  const index = new MemoryIndex();
  (await index.search({ query: "widget" }));
  index.close();
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
  db.exec("DROP TABLE memory_injection_names; BEGIN IMMEDIATE");
  try {
    const started = performance.now();
    expect(() => index.claimHook("cold-conversation", "cold-turn")).toThrow();
    expect(performance.now() - started).toBeLessThan(500);
  } finally { db.exec("ROLLBACK"); db.close(); }
  try { expect(index.claimHook("cold-conversation", "cold-turn")).toBeTrue(); }
  finally { index.close(); }
});

for (const engine of ["claude", "codex"] as const) test(`${engine} ambiguous identical journal rows cannot establish operator authorship`, () => {
  const transcript = fixture("ambiguous.jsonl", ""), index = new MemoryIndex(), prompt = "Repeat widget input";
  const line = (id: string) => JSON.stringify(engine === "claude"
    ? { type: "user", uuid: id, message: { role: "user", content: prompt } }
    : { type: "response_item", payload: { type: "message", turn_id: id, role: "user", content: [{ type: "input_text", text: prompt }] } }) + "\n";
  try {
    index.recordTerminalDelivery("ambiguous-machine", "ambiguous-conversation", prompt, "agent", transcript);
    fs.appendFileSync(transcript, line("synthetic-queued") + line("synthetic-machine"));
    expect(index.terminalOrigin("ambiguous-conversation", "native:synthetic-machine", prompt, transcript, engine)).toBe("unknown");
    index.close();
    expect(index.terminalOrigin("ambiguous-conversation", "native:synthetic-machine", prompt, transcript, engine)).toBe("unknown");
    // Positive ownership protects that operator id; other same-text ids stay unknown.
    index.recordNativeTurn("ambiguous-conversation", "native:synthetic-queued", transcript, 0, prompt);
    expect(index.terminalOrigin("ambiguous-conversation", "native:synthetic-machine", prompt, transcript, engine)).toBe("unknown");
    fs.appendFileSync(transcript, line("synthetic-typed"));
    expect(index.terminalOrigin("ambiguous-conversation", "native:synthetic-typed", prompt, transcript, engine)).toBe("unknown");
    index.recordNativeTurn("ambiguous-conversation", "native:synthetic-typed", transcript, 0, prompt);
    expect(index.terminalOrigin("ambiguous-conversation", "native:synthetic-typed", prompt, transcript, engine)).toBe("operator");
  } finally { index.close(); }
});

for (const engine of ["claude", "codex"] as const) test(`${engine} two queued identical machine receipts cannot prove native operator authorship`, () => {
  const transcript = fixture("queued.jsonl", ""), index = new MemoryIndex(), prompt = "Repeat widget input";
  try {
    index.recordTerminalDelivery("queued-first", "queued-conversation", prompt, "agent", transcript);
    index.recordTerminalDelivery("queued-second", "queued-conversation", prompt, "agent", transcript);
    expect(index.terminalOrigin("queued-conversation", "native:synthetic-first", prompt, transcript, engine)).toBe("unknown");
    const line = JSON.stringify(engine === "claude" ? { type: "user", uuid: "synthetic-first", message: { role: "user", content: prompt } }
      : { type: "response_item", payload: { type: "message", turn_id: "synthetic-first", role: "user", content: [{ type: "input_text", text: prompt }] } });
    fs.appendFileSync(transcript, line + "\n");
    expect(index.terminalOrigin("queued-conversation", "native:synthetic-second", prompt, transcript, engine)).toBe("unknown");
    expect(index.terminalOrigin("queued-conversation", "native:synthetic-typed", prompt, transcript, engine)).toBe("unknown");
  } finally { index.close(); }
});

test("candidate scope reads an alias chain during writer contention without rewriting old rows", async () => {
  const index = new MemoryIndex();
  await index.refresh([{ path: fixture("old-project.md", "---\nname: Widget parser\ndescription: Widget delimiters require paired escaping.\ntype: project\n---\nWidget delimiters require paired escaping.\n"),
    engine: "claude", sourceKind: "claude_memory", project: "fixture-older-key" }]);
  persistProjectAliases([{ source: "fixture-older-key", target: "fixture-intermediate", displayName: "Widgets" },
    { source: "fixture-intermediate", target: "fixture-current-key", displayName: "Widgets" }]);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite")); db.exec("BEGIN IMMEDIATE");
  try {
    expect((await index.injectionCandidates("widget delimiters", "fixture-current-key", "codex", "fixture-conversation"))).toHaveLength(1);
    expect(db.query("SELECT project FROM memory_entries").get()).toEqual({ project: "fixture-older-key" });
  } finally { db.exec("ROLLBACK"); db.close(); index.close(); }
});

test("candidate deadline reports retrieval timeout separately from an empty index", async () => {
  const index = new MemoryIndex();
  let reason = "";
  try {
    expect((await index.injectionCandidates("widget", "fixture-project", "claude", "fixture-conversation", performance.now() - 1,
      { reason: value => { reason = value; } }))).toEqual([]);
    expect(reason).toBe("candidateTimeout");
  } finally { index.close(); }
});
