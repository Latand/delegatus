import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";

const script = path.resolve(import.meta.dir, "memory-replay.ts");
function fixture(scenario = "complete", rejectedId = "../../sentinel") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-replay-test-"));
  try {
    const repo = path.join(root, "repo"), state = path.join(root, "state");
    let out = path.join(root, "out");
    fs.mkdirSync(repo); fs.mkdirSync(state);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    const tree = execFileSync("git", ["-C", repo, "mktree"], { input: "", encoding: "utf8" }).trim();
    const base = execFileSync("git", ["-C", repo, "hash-object", "-t", "commit", "-w", "--stdin"], { input: `tree ${tree}\nauthor Fixture <noreply> 1 +0000\ncommitter Fixture <noreply> 1 +0000\n\nbase\n`, encoding: "utf8" }).trim();
    git("update-ref", "refs/heads/main", base);
    const role = { roleId: "builder", engine: "codex", access: "read-write", promptScaffold: "Check {{task}} and {{prev.output}}" };
    const pipeline = { id: "lane", project: "fixture", repoDir: repo, baseRef: base, branch: "work", task: "Build a widget", spec: "Validate shape", stages: [{ id: "build", role: { roleId: "builder" } }, { id: "review", role: { roleId: "reviewer" } }, { id: "fix", role: { roleId: "builder" } }], runs: [
      { stageId: "build", attempts: [{ n: 1, startedAt: "2026-01-02", completedAt: "2026-01-03", effectiveRole: role, definition: { prompt: "{{task}} {{prev.output}}" }, input: "Frozen relay" }] },
      { stageId: "review", attempts: [{ n: 1, startedAt: "2026-01-04", completedAt: "2026-01-05", effectiveRole: { roleId: "reviewer" }, verdict: { status: "fail", findings: [{ text: "Schema defect; reproduce: run shape probe" }] } }] },
      { stageId: "fix", attempts: [{ n: 1, startedAt: "2026-01-06", effectiveRole: role, activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }] },
    ] };
    const memory: Record<string, unknown>[] = [
      { kind: "scope", scope: "role:fixture:builder", active: ["old", "new"], history: [{ at: "2026-01-01", revision: 1, added: ["old"], archived: [] }, { at: "2026-01-07", revision: 2, added: ["new"], archived: [] }] },
      { kind: "rule", id: "old", scope: "role:fixture:builder", rule: "Changed later", createdAt: "2026-01-01", changedAt: "2026-01-08" },
      { kind: "rule", id: "version", versionOf: "old", rule: "Original guidance", changedAt: "2026-01-08" },
      { kind: "rule", id: "new", scope: "role:fixture:builder", rule: "Validate every schema", createdAt: "2026-01-07", changedAt: "2026-01-07", source: { pipelineId: "lane", stageId: "fix", attempt: 1 } },
      { kind: "request", pipelineId: "lane", stageId: "fix", attempt: 1, at: "2026-01-06T12:00:00Z", ruleIds: ["new"] },
    ];
    if (scenario === "history") memory[0] = { ...memory[0], history: [{ at: "2026-01-07", revision: 20, added: ["new"], archived: [] }] };
    if (scenario === "mismatch") memory[3] = { ...memory[3], rule: "Take screenshots at every width" };
    if (scenario === "request-rewrite") {
      memory[3] = { ...memory[3], createdAt: "2026-01-01", revisedBy: { by: "agent", at: "2026-01-07", source: { pipelineId: "lane", stageId: "fix", attempt: 1 } } };
      memory[4] = { ...memory[4], ruleIds: [], rewrote: "new" };
      memory.push({ kind: "rule", id: "prior-new", versionOf: "new", rule: "Old wording", changedAt: "2026-01-07" });
    }
    if (scenario === "rewrite") {
      memory[3] = { ...memory[3], rule: "A later unrelated instruction", changedAt: "2026-01-10" };
      memory.push({ kind: "rule", id: "new-version", versionOf: "new", rule: "Validate every schema", changedAt: "2026-01-10" });
    }
    if (scenario.startsWith("middle-archive")) {
      memory[0] = { ...memory[0], active: ["old", "third", "new"], history: [
        { at: "2026-01-01T00:00:00Z", revision: 1, added: ["old"], archived: [] },
        { at: "2026-01-01T01:00:00Z", revision: 2, added: ["second"], archived: [] },
        { at: "2026-01-01T02:00:00Z", revision: 3, added: ["third"], archived: [] },
        { at: "2026-01-07", revision: 4, added: ["new"], archived: [] },
        { at: "2026-01-09", revision: 5, added: [], archived: ["second"],
          ...(scenario === "middle-archive-before" ? { before: ["old", "second", "third", "new"] } : {}) },
      ] };
      for (const id of ["second", "third"]) memory.push({ ...memory[1], id, rule: `${id} guidance`, changedAt: "2026-01-01" });
    }
    if (scenario === "order-rewrite" || scenario === "order-merge") {
      memory[0] = { ...memory[0], active: ["new", "old"], history: [
        { at: "2026-01-01", revision: 1, added: ["old"], archived: [] },
        { at: "2026-01-07", revision: 2, added: ["new"], archived: [] },
        { at: "2026-01-09", revision: 3, added: [], archived: [],
          ...(scenario === "order-rewrite" ? { rewritten: [{ id: "old", version: "version" }] }
            : { merged: [{ from: "duplicate", into: "old" }] }) },
      ] };
    }
    const db = new Database(path.join(state, "state.sqlite"));
    db.exec("CREATE TABLE state_rows(collection TEXT, row_key TEXT, value_json TEXT)");
    const put = (collection: string, key: string, row: unknown) => db.run("INSERT INTO state_rows VALUES(?,?,?)", [collection, key, JSON.stringify(row)]);
    put("pipelines", "lane", pipeline);
    put("pipelines", "live", { ...pipeline, id: "live", task: "Read https://example.invalid/task" });
    put("role_memory", "live-request", { ...memory[4], pipelineId: "live", ruleIds: ["live-new"] });
    put("role_memory", "live-new", { ...memory[3], id: "live-new", source: { pipelineId: "live", stageId: "fix", attempt: 1 } });
    if (scenario === "unsafe-id") {
      put("pipelines", "unsafe", { ...pipeline, id: rejectedId });
      put("role_memory", "unsafe-request", { ...memory[4], pipelineId: rejectedId });
    }
    memory.forEach((row, i) => put("role_memory", String(i), row)); db.close();
    const sentinel = path.join(root, "sentinel");
    fs.mkdirSync(sentinel);
    const protectedFiles = [sentinel, state, repo].map(dir => path.join(dir, "keep.txt"));
    for (const file of protectedFiles) fs.writeFileSync(file, "existing data\n");
    const before = fs.readFileSync(path.join(state, "state.sqlite"));
    const gitConfig = path.join(root, "gitconfig");
    fs.writeFileSync(gitConfig, scenario === "bundle-failure" ? "[protocol \"file\"]\n\tallow = never\n" : "");
    if (scenario.endsWith("parent-link")) {
      const target = scenario === "checkout-parent-link" ? path.join(repo, "nested")
        : scenario === "source-parent-link" ? path.join(state, "nested") : path.join(root, "outside");
      fs.mkdirSync(target);
      const link = path.join(root, "parent-link");
      fs.symlinkSync(target, link, "dir");
      out = path.join(link, "replay");
    }
    const run = () => execFileSync(process.execPath, [script, "--state-dir", state, "--output", out], { stdio: "pipe", env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, TMPDIR: root, LLV_STATE_DIR: state, GIT_CONFIG_GLOBAL: gitConfig } });
    if (scenario === "checkout-parent-link" || scenario === "source-parent-link") {
      expect(run).toThrow();
      expect(fs.existsSync(out)).toBe(false);
    } else run();
    for (const file of protectedFiles) expect(fs.readFileSync(file, "utf8")).toBe("existing data\n");
    expect(fs.readFileSync(path.join(state, "state.sqlite"))).toEqual(before);
    expect(git("rev-parse", "main")).toBe(base);
    if (scenario === "checkout-parent-link" || scenario === "source-parent-link") return;
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    if (scenario === "history" || scenario === "mismatch" || scenario === "bundle-failure" || scenario === "middle-archive" || scenario.startsWith("order-")) {
      expect(manifest.items).toHaveLength(0); expect(manifest.dropped).toHaveLength(2);
      const reason = scenario === "history" ? "retained history" : scenario === "mismatch" ? "finding class"
        : scenario === "middle-archive" || scenario.startsWith("order-") ? "scope order unavailable" : "base commit or bundle unavailable";
      expect(manifest.dropped.some((r: { reason: string }) => r.reason.includes(reason))).toBe(true);
      if (scenario === "middle-archive" || scenario.startsWith("order-")) expect(manifest.dropped).toContainEqual({ id: "lane", reason });
      expect(fs.readdirSync(path.join(out, "items"))).toEqual([]);
      return;
    }
    expect(manifest.items).toHaveLength(1); expect(manifest.dropped).toHaveLength(scenario === "unsafe-id" ? 2 : 1);
    if (scenario === "unsafe-id") expect(manifest.dropped).toContainEqual({ id: rejectedId, reason: "unsafe item id" });
    const input = JSON.parse(fs.readFileSync(path.join(out, "items", "lane", "input.json"), "utf8"));
    expect(input.baseCommit).toBe(base); expect(input.message).toContain("Frozen relay");
    const expectedRules = scenario === "middle-archive-before"
      ? [{ id: "third", text: "third guidance" }, { id: "second", text: "second guidance" }, { id: "old", text: "Original guidance" }]
      : [{ id: "old", text: "Original guidance" }];
    expect(input.rules.map(({ id, text }: { id: string; text: string }) => ({ id, text }))).toEqual(expectedRules);
    expect(input.learnedRuleLines).toBe(expectedRules.map(r => `- [${r.id}] ${r.text}`).join("\n"));
    const blockLines = input.learnedRuleBlock.split("\n").filter((line: string) => line.startsWith("- ["));
    expect(blockLines).toEqual(expectedRules.map(r => `- [${r.id}] ${r.text}`));
    expect(JSON.stringify(input)).not.toContain("Schema defect");
    const oracle = JSON.parse(fs.readFileSync(path.join(out, "oracle", "lane.json"), "utf8"));
    expect(oracle.findings[0].reproduction).toContain("run shape probe");
    expect(oracle.rules[0].text).toBe("Validate every schema");
    execFileSync("git", ["bundle", "verify", path.join(out, "items", "lane", "base.bundle")], { cwd: repo, stdio: "pipe" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("free replay freezes historical inputs and isolates the oracle without changing state", () => fixture());
test("replay rejects inputs outside retained history", () => fixture("history"));
test("replay rejects a lesson with no matching finding class", () => fixture("mismatch"));
test("replay freezes the rule at the lesson time before a later rewrite", () => fixture("rewrite"));

test("replay resolves a rewrite from its attempt provenance after the lesson request", () => fixture("request-rewrite"));

test.each(["../../sentinel", "../../state", "../../repo", "../oracle", "..", ".", ""])(
  "replay preserves existing sibling and source directories when rejecting id %j",
  id => fixture("unsafe-id", id),
);
test("replay removes its created item directory when bundling fails", () => fixture("bundle-failure"));
test("reject a private export whose parent symlink resolves inside a checkout", () => fixture("checkout-parent-link"));
test("reject a private export whose parent symlink resolves inside source state", () => fixture("source-parent-link"));
test("allow a private export through a parent symlink to an outside directory", () => fixture("outside-parent-link"));
test("reject a later middle-rule archive without its original order", () => fixture("middle-archive"));
test("restore original delivered order after a later middle-rule archive with saved order", () => fixture("middle-archive-before"));
test.each(["order-rewrite", "order-merge"])("reject a later %s without its original order", scenario => fixture(scenario));
