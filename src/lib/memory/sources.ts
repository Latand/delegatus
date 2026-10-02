import fs from "node:fs/promises";
import path from "node:path";

import { projectForClaudeMemorySlug } from "@/lib/scanner/describe";
import type { MemorySource } from "./parsers";

export interface MemoryRoots {
  claudeHomes: readonly string[];
  codexHome: string;
  skillRoots: readonly string[];
  projectForSlug?: (slug: string) => string;
}

/** Only known memory locations are traversed. Symlinked shared stores are read once. */
export async function discoverMemorySources(roots: MemoryRoots) {
  const sources: MemorySource[] = [];
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  let complete = true;
  const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
  async function add(filename: string, source: Omit<MemorySource, "path">) {
    try {
      const real = await fs.realpath(filename);
      if (seenFiles.has(real) || !(await fs.stat(real)).isFile()) return;
      seenFiles.add(real); sources.push({ path: real, ...source });
    } catch (error) { if (!missing(error)) complete = false; }
  }
  async function walk(directory: string, accept: (filename: string) => Omit<MemorySource, "path"> | null, depth = 0) {
    try {
      const real = await fs.realpath(directory);
      if (seenDirectories.has(real)) return;
      if (depth > 12) { complete = false; return; }
      seenDirectories.add(real);
      for (const entry of (await fs.readdir(real, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".")) continue;
        const filename = path.join(real, entry.name);
        let stat;
        try { stat = await fs.stat(filename); }
        catch (error) { if (!missing(error)) complete = false; continue; }
        if (stat.isDirectory()) await walk(filename, accept, depth + 1);
        else { const source = accept(filename); if (source) await add(filename, source); }
      }
    } catch (error) { if (!missing(error)) complete = false; }
  }
  for (const home of roots.claudeHomes) {
    await add(path.join(home, "CLAUDE.md"), { engine: "claude", sourceKind: "instruction" });
    await walk(path.join(home, "rules"), filename => filename.endsWith(".md") ? { engine: "claude", sourceKind: "instruction" } : null);
    const projects = path.join(home, "projects");
    try {
      for (const entry of (await fs.readdir(projects, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
        const project = (roots.projectForSlug ?? projectForClaudeMemorySlug)(entry.name);
        await walk(path.join(projects, entry.name, "memory"), filename => filename.endsWith(".md") ? {
          engine: "claude", project, sourceKind: path.basename(filename) === "MEMORY.md" ? "claude_index" : "claude_memory",
        } : null);
      }
    } catch (error) { if (!missing(error)) complete = false; }
  }
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    await add(path.join(roots.codexHome, name), { engine: "codex", sourceKind: "instruction" });
  }
  const memory = path.join(roots.codexHome, "memories");
  await add(path.join(memory, "MEMORY.md"), { engine: "codex", sourceKind: "codex_memory" });
  await add(path.join(memory, "memory_summary.md"), { engine: "codex", sourceKind: "codex_summary" });
  await walk(path.join(memory, "rollout_summaries"), filename => filename.endsWith(".md") ? { engine: "codex", sourceKind: "rollout_summary" } : null);
  for (const directory of [...roots.skillRoots, path.join(memory, "skills")]) {
    await walk(directory, filename => path.basename(filename) === "SKILL.md" ? { engine: "shared", sourceKind: "skill" } : null);
  }
  return { sources, complete };
}
