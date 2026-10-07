import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverMemorySources } from "./sources";

test("discovery leaves a slug shared by a repository and a plain folder unresolved", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-slug-discovery-"));
  try {
    const repo = path.join(root, "team-repo"), other = path.join(root, "team", "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true }); fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(repo, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/fixture/widgets.git\n');
    const slug = repo.replace(/[^a-zA-Z0-9]/g, "-");
    const memory = path.join(root, "claude", "projects", slug, "memory");
    fs.mkdirSync(memory, { recursive: true }); fs.writeFileSync(path.join(memory, "topic.md"), "synthetic");
    const found = await discoverMemorySources({ claudeHomes: [path.join(root, "claude")], codexHome: path.join(root, "absent-codex"), skillRoots: [] });
    expect(found.sources).toHaveLength(1); expect(found.sources[0].project).toBe(slug);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("discovery reads managed Claude memories, shared Codex memory, global instructions and linked single-fact skills", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-discovery-"));
  const write = (relative: string, body = "synthetic") => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, body);
    return filename;
  };
  try {
    write("claude/projects/encoded-project/memory/MEMORY.md");
    write("claude/projects/encoded-project/memory/topic.md");
    write("claude/projects/encoded-project/memory/imported/note.md");
    write("claude/projects/encoded-project/memory/imported/MEMORY.md");
    write("claude/CLAUDE.md");
    write("codex/memories/MEMORY.md");
    write("codex/memories/memory_summary.md");
    write("codex/memories/rollout_summaries/example.md");
    write("codex/memories/.git/ignored.md");
    write("codex/AGENTS.md");
    write("skills/widget/SKILL.md");
    fs.symlinkSync(path.join(root, "missing"), path.join(root, "skills", "aaa-missing"));
    fs.mkdirSync(path.join(root, "managed", "projects", "encoded-project"), { recursive: true });
    fs.symlinkSync(path.join(root, "claude", "projects", "encoded-project", "memory"), path.join(root, "managed", "projects", "encoded-project", "memory"));
    fs.symlinkSync(path.join(root, "skills", "widget"), path.join(root, "skills", "widget-link"));
    const options = { claudeHomes: [path.join(root, "claude"), path.join(root, "managed")], codexHome: path.join(root, "codex"), skillRoots: [path.join(root, "skills")], projectForSlug: () => "project-a" };
    const sources = await discoverMemorySources(options);
    expect(sources.complete).toBe(true);
    expect(sources.sources).toHaveLength(10);
    expect(sources.sources.filter(source => source.engine === "claude" && source.project === "project-a")).toHaveLength(4);
    expect(sources.sources.map(source => source.sourceKind).sort()).toEqual(["claude_index", "claude_index", "claude_memory", "claude_memory", "codex_memory", "codex_summary", "instruction", "instruction", "rollout_summary", "skill"]);
    expect(sources.sources.find(source => source.path.endsWith("memory/MEMORY.md"))?.loadedByDefault).toBe(true);
    expect(sources.sources.find(source => source.path.endsWith("imported/MEMORY.md"))?.loadedByDefault).toBe(false);
    expect(fs.existsSync(path.join(root, "codex", "memories", "memory-index.sqlite"))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
