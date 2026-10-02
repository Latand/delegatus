import { projectForCwd } from "@/lib/scanner/describe";

export const MEMORY_KINDS = ["preference", "project_fact", "reference", "failure", "instruction", "skill"] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];
export type MemorySourceKind = "claude_memory" | "claude_index" | "codex_memory" | "codex_summary" | "rollout_summary" | "instruction" | "skill";

export interface MemorySource {
  path: string;
  sourceKind: MemorySourceKind;
  engine: "claude" | "codex" | "shared";
  project?: string;
}

export interface ParsedMemory {
  anchor: string;
  kind: MemoryKind;
  title: string;
  summary: string;
  body: string;
  project?: string;
  writtenAt?: string;
}

export function parseMemory(source: MemorySource, text: string): ParsedMemory[] {
  if (source.sourceKind === "codex_memory") return parseCodexRegistry(text);
  if (source.sourceKind === "codex_summary") return parseCodexSummary(text);
  if (source.sourceKind === "rollout_summary") {
    const cwd = /^cwd:\s*(.+)$/m.exec(text)?.[1]?.trim();
    const project = cwd ? projectForCwd(cwd) : null;
    if (!project || /^polluted:\s*(?:true|yes|1)\s*$/mi.test(text)) return [];
    return bullets(text, "reference", project, /^#\s+(.+)$/m.exec(text)?.[1] ?? "Rollout summary", /^updated_at:\s*(.+)$/m.exec(text)?.[1]);
  }
  if (source.sourceKind === "claude_index") {
    if (!source.project) return [];
    return text.split(/\r?\n/).flatMap(line => {
      const link = /\[([^\]]+)\]\(([^)]+\.md)\)/.exec(line);
      return link ? [{ anchor: `reference:${link[2]}`, kind: "reference" as const, title: link[1], summary: line, body: line, project: source.project }] : [];
    });
  }
  if (source.sourceKind === "instruction") {
    return text.trim() ? [{ anchor: "instruction", kind: "instruction", title: "Global instructions", summary: text, body: text, project: source.project }] : [];
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!frontmatter) return [];
  const field = (key: string) => new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(frontmatter[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const title = field("name"), summary = field("description"), type = field("type");
  if (source.sourceKind === "skill") {
    return title && summary && frontmatter[2].trim() ? [{ anchor: "skill", kind: "skill", title, summary, body: frontmatter[2], project: source.project }] : [];
  }
  const kind = type === "user" || type === "feedback" ? "preference" : type === "project" ? "project_fact" : type === "reference" ? "reference" : null;
  if (!title || !summary || !kind || !source.project || !frontmatter[2].trim()) return [];
  return [{ anchor: "topic", kind, title, summary, body: frontmatter[2], project: source.project, writtenAt: field("modified") }];
}

function sectionKind(heading: string): MemoryKind | null {
  if (/^(?:user )?preferences$/i.test(heading)) return "preference";
  if (/^(?:reusable knowledge|learnings)$/i.test(heading)) return "project_fact";
  if (/^failures(?: and how to do differently)?$/i.test(heading)) return "failure";
  return null;
}

function bullets(text: string, kind: MemoryKind, project: string | undefined, title: string, writtenAt?: string): ParsedMemory[] {
  const result: ParsedMemory[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^[-*] /.test(lines[i])) continue;
    let body = lines[i].slice(2);
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) body += "\n" + lines[++i].trim();
    if (body.trim()) result.push({ anchor: `${title}\0${kind}\0${body.trim().replace(/\s+/gu, " ")}`, kind, title, summary: body, body, project, writtenAt });
  }
  return result;
}

function parseCodexRegistry(text: string): ParsedMemory[] {
  if (!/^# Task Group:\s*\S/m.test(text)) return [];
  const entries: ParsedMemory[] = [];
  // A task can have its own cwd; never grant project facts global scope on an unknown shape.
  for (const group of text.split(/(?=^# Task Group:)/m)) {
    if (!group.startsWith("# Task Group:")) continue;
    const groupTitle = group.split("\n")[0].replace(/^# Task Group:\s*/, "");
    for (const task of group.split(/(?=^## Task \d+:)/m)) {
      const cwds = [...task.matchAll(/\bcwd(?:=|:)\s*([^,\n)]+)/g)].map(match => match[1].trim().replace(/^`|`$/g, ""));
      const projects = [...new Set(cwds.map(cwd => projectForCwd(cwd)).filter(Boolean))];
      if (!cwds.length || projects.length !== 1 || cwds.some(cwd => !projectForCwd(cwd))) continue;
      const project = projects[0]!;
      const title = /^## Task \d+:\s*(.+)$/m.exec(task)?.[1] ?? groupTitle;
      const writtenAt = [...task.matchAll(/\bupdated_at(?:=|:)\s*([^,\n)]+)/g)].map(match => match[1].trim()).sort().at(-1);
      const keywords = /^### keywords\r?\n([\s\S]*?)(?=^### |$(?![\s\S]))/mi.exec(task)?.[1] ?? "";
      for (const section of task.split(/(?=^### )/m)) {
        const heading = /^### (.+)$/m.exec(section)?.[1]?.trim();
        const kind = heading ? sectionKind(heading) : null;
        if (!kind) continue;
        for (const entry of bullets(section, kind, project, title, writtenAt)) {
          entry.anchor = `${groupTitle}\0${[...new Set(cwds)].sort().join("\0")}\0${entry.anchor}`;
          entry.body += "\n" + keywords;
          entries.push(entry);
        }
      }
    }
  }
  return entries;
}

function parseCodexSummary(text: string): ParsedMemory[] {
  if (!/^v1\s*(?:\r?\n|$)/.test(text)) return [];
  const entries: ParsedMemory[] = [];
  let inRouting = false;
  let project: string | undefined;
  let projectDepth = 0;
  let projectHeading = "";
  for (const section of text.split(/(?=^#{2,6} )/m)) {
    const match = /^(#{2,6}) (.+)$/m.exec(section);
    if (!match) continue;
    const heading = match[2].trim(), depth = match[1].length;
    if (heading === "What's in Memory") { inRouting = true; project = undefined; continue; }
    const globalSection = /^(User Profile|User preferences|General Tips)$/i.test(heading) && (!inRouting || depth <= 2);
    if (globalSection) { inRouting = false; project = undefined; }
    if (inRouting) {
      const cwd = heading.replace(/^`|`$/g, "");
      if (cwd.startsWith("/")) {
        project = projectForCwd(cwd) ?? undefined; projectDepth = depth; projectHeading = cwd;
      } else if (depth <= projectDepth) project = undefined;
    }
    const kind = inRouting ? "reference" : globalSection ? "preference" : null;
    if (!kind || (inRouting && !project)) continue;
    for (const entry of bullets(section, kind, project, heading)) {
      if (inRouting) entry.anchor = `${projectHeading}\0${entry.anchor}`;
      entries.push(entry);
    }
  }
  return entries;
}
