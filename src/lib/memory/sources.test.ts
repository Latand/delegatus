import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverMemorySources } from "./sources";

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
    expect(sources.sources).toHaveLength(9);
    expect(sources.sources.filter(source => source.engine === "claude" && source.project === "project-a")).toHaveLength(3);
    expect(sources.sources.map(source => source.sourceKind).sort()).toEqual(["claude_index", "claude_memory", "claude_memory", "codex_memory", "codex_summary", "instruction", "instruction", "rollout_summary", "skill"]);
    expect(fs.existsSync(path.join(root, "codex", "memories", "memory-index.sqlite"))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
