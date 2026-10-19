import { createHash } from "node:crypto";
import type { ImportCandidate, ImportManifestFile, ImportOccurrence, ImportWriter } from "./importTypes";
import { parseMemory } from "./parsers";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const unknown: ImportWriter = { kind: "unknown", roleId: null };
export function topicMetadata(text: string) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const field = (key: string) => new RegExp(`^${key}:\\s*([^\\r\\n]+)$`, "m").exec(front?.[1] ?? "")?.[1]?.trim().replace(/^["']|["']$/g, "");
  const type = field("type");
  return { normalized: text.slice(front?.[0].length ?? 0).trim().replace(/\s+/gu, " "), title: field("name"),
    type: ["user", "feedback", "project", "reference"].includes(type ?? "") ? type as ImportOccurrence["type"] : null,
    session: field("session_id") ?? field("session") ?? field("sessionId"), modified: field("modified") };
}

/** Keep all bytes, prefer complete lines, and never cut a UTF-8 code point. */
function parts(text: string): { body: string; bytes: [number, number] }[] {
  const bytes = Buffer.from(text), result: { body: string; bytes: [number, number] }[] = [];
  let start = 0;
  do {
    let end = Math.min(start + 8192, bytes.length);
    if (end < bytes.length) {
      const newline = bytes.lastIndexOf(10, end - 1);
      if (newline >= start) end = newline + 1;
      else while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
    }
    result.push({ body: bytes.toString("utf8", start, end), bytes: [start, end] });
    start = end;
  } while (start < bytes.length);
  return result;
}

export class ImportCandidates {
  private groups = new Map<string, ImportCandidate[]>();
  constructor(private importId: string) {}

  add(file: ImportManifestFile, text: string, writer = unknown) {
    const topic = topicMetadata(text);
    const occurrence: ImportOccurrence = { id: `o_${hash(`${file.engine}\0${file.home}\0${file.file}\0${file.sha256}`).slice(0, 16)}`, file: file.file, sha256: file.sha256,
      type: file.engine === "codex" ? "summary" : topic.type, writtenAt: topic.modified && Number.isFinite(Date.parse(topic.modified)) ? topic.modified : file.modifiedAt, writer, project: file.project };
    if (file.kind === "claude_topic") this.group(file, occurrence, "topic", topic.title ?? file.file.split(/[\\/]/).at(-1)!, text, topic.normalized);
    if (file.kind === "codex_summary") {
      for (const bullet of parseMemory({ engine: "codex", path: file.file, sourceKind: "codex_summary" }, text)) {
        this.group({ ...file, project: bullet.project ?? null }, { ...occurrence, project: bullet.project ?? null }, bullet.anchor, bullet.title, bullet.body, bullet.body.trim().replace(/\s+/gu, " "));
      }
    }
  }
  private group(file: ImportManifestFile, occurrence: ImportOccurrence, anchor: string, title: string, body: string, normalized: string) {
    const contentSha256 = hash(normalized);
    const identity = JSON.stringify([file.engine, contentSha256, occurrence.project, occurrence.type, occurrence.writer.kind, occurrence.writer.roleId]);
    const existing = this.groups.get(identity);
    if (existing) {
      for (const candidate of existing) {
        if (!candidate.occurrences.some(item => item.id === occurrence.id)) candidate.occurrences.push(occurrence);
        candidate.loadedAtStart ||= file.loadedAtStart;
      }
      return;
    }
    const split = parts(body);
    const id = (index: number) => `c_${hash(`${this.importId}\0${identity}\0${index}`).slice(0, 16)}`;
    const project = occurrence.project, writer = occurrence.writer;
    const scope = occurrence.type === "user" || !project ? "machine"
      : writer.kind === "seat" ? `role:${project}:orchestrator` : writer.kind === "stage" && writer.roleId ? `role:${project}:${writer.roleId}` : `project:${project}`;
    this.groups.set(identity, split.map((part, index) => ({ kind: "candidate", id: id(index), importId: this.importId, engine: file.engine, store: file.engine === "claude" ? "claude_topic" : "codex_summary", group: id(0), part: { index, of: split.length, bytes: part.bytes }, contentSha256, linked: [], occurrences: [occurrence], anchor, loadedAtStart: file.loadedAtStart, suggestedScope: scope, title, body: part.body, dispositions: [] })));
  }
  rows(): ImportCandidate[] {
    const groups = [...this.groups.values()];
    for (const group of groups) for (const part of group) part.linked = groups.filter(other => other !== group && other[0].contentSha256 === part.contentSha256).flatMap(other => other.map(candidate => candidate.id)).sort();
    return groups.flat();
  }
}
