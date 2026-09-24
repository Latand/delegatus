import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
  candidateFor,
  claudeSessionKind,
  classifyUserRecord,
  codexSessionKind,
  dedupeCandidates,
  parseClaudeUserRecord,
  parseCodexUserRecord,
  type ExclusionReason,
  type ExportManifest,
  type HumanInput,
  type InputCandidate,
  type LaunchKind,
  type TranscriptContext,
  type UserRecord,
} from "./humanInput";

/*
 * One host's transcripts into human-input events (the exporter's core; the
 * command is `scripts/export-human-input.ts`). It reads every transcript file
 * modified since the window began — a session that began days earlier still
 * holds messages inside it, so files are chosen by modification time and never
 * by the date directory a session was filed under — and every message is kept
 * or dropped by its own timestamp.
 *
 * The project comes from the conversation's context: the host registry's
 * ownership or task binding, otherwise the conversation's working directory.
 * A message's text never decides a project.
 */

/** What the transcript itself says about its conversation. */
export interface TranscriptFacts {
  path: string;
  engine: "claude" | "codex";
  /** The working directory the conversation ran in, from its own records. */
  cwd: string | null;
  /** Claude: the entrypoint of its first user record. */
  entrypoint: string | null;
  /** Codex: the `session_meta` payload. */
  sessionMeta: unknown;
}

/** What the host knows about the conversation beyond its transcript. */
export interface ConversationResolution {
  project: string | null;
  /** How the host's registry says it was launched; null when unregistered. */
  launch: LaunchKind | null;
  registered: boolean;
  /** A stable identity for the fan-out rule, when the registry has one. */
  conversation?: string;
  deliveryOrigin?: TranscriptContext["deliveryOrigin"];
}

export interface ExportRequest {
  host: string;
  from: number;
  to: number;
  now: number;
  files: readonly string[];
  resolve(facts: TranscriptFacts): ConversationResolution;
}

export interface ExportResult {
  manifest: Omit<ExportManifest, "v" | "type">;
  inputs: HumanInput[];
}

/** Every `.jsonl` under the roots modified at or after `sinceMs`, each real
    file once and by its real path (a store linked into two roots is one
    store, and the real path is the one the registry records). */
export function listTranscriptFiles(roots: readonly string[], sinceMs: number): string[] {
  const found = new Map<string, string>();
  const visited = new Set<string>();
  const walk = (dir: string) => {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of entries) {
      const target = path.join(dir, item.name);
      if (item.isDirectory() || (item.isSymbolicLink() && isDirectory(target))) walk(target);
      else if (item.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(target);
          if (stat.isFile() && stat.mtimeMs >= sinceMs) {
            const realFile = fs.realpathSync(target);
            found.set(realFile, realFile);
          }
        } catch {
          /* Vanished while walking. */
        }
      }
    }
  };
  for (const root of roots) walk(root);
  return [...found.values()].sort();
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

interface ParsedTranscript {
  facts: TranscriptFacts;
  records: UserRecord[];
}

/** One transcript's facts and user records. Lines that cannot hold either are
    skipped before they are parsed. */
export async function readTranscript(file: string): Promise<ParsedTranscript | null> {
  let engine: "claude" | "codex" | null = null;
  let cwd: string | null = null;
  let entrypoint: string | null = null;
  let sessionMeta: unknown = null;
  const records: UserRecord[] = [];
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const relevant = engine === null || line.includes("\"user\"") || line.includes("session_meta") || (cwd === null && line.includes("\"cwd\""));
    if (!relevant) continue;
    let parsed: Record<string, unknown> | null;
    try {
      parsed = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (engine === null) engine = parsed.type === "session_meta" || parsed.type === "response_item" || parsed.type === "turn_context" ? "codex" : "claude";
    if (engine === "codex") {
      const payload = record(parsed.payload);
      if (parsed.type === "session_meta") {
        sessionMeta ??= payload;
        if (cwd === null && typeof payload?.cwd === "string") cwd = payload.cwd;
      }
      if (parsed.type === "turn_context" && cwd === null && typeof payload?.cwd === "string") cwd = payload.cwd;
      const user = parseCodexUserRecord(parsed);
      if (user) records.push(user);
    } else {
      if (cwd === null && typeof parsed.cwd === "string") cwd = parsed.cwd;
      const user = parseClaudeUserRecord(parsed);
      if (user) {
        if (entrypoint === null && typeof parsed.entrypoint === "string") entrypoint = parsed.entrypoint;
        records.push(user);
      }
    }
  }
  if (engine === null) return null;
  return { facts: { path: file, engine, cwd, entrypoint, sessionMeta }, records };
}

/** Records that say nothing about who started the conversation: seeing one
    does not make the next record the conversation's first message. */
const PRELUDE: ReadonlySet<ExclusionReason> = new Set(["injected", "attachment", "notification", "interrupt"]);

/**
 * Human inputs of one host inside [from, to], deduplicated, and a manifest
 * with the counts of every record excluded, by reason.
 */
export async function exportHumanInputs(request: ExportRequest): Promise<ExportResult> {
  const until = Math.min(request.to, request.now);
  const candidates: InputCandidate[] = [];
  const excluded: Partial<Record<ExclusionReason, number>> = {};
  let seen = 0;
  for (const file of request.files) {
    const transcript = await readTranscript(file);
    if (!transcript) continue;
    const resolution = request.resolve(transcript.facts);
    const context: TranscriptContext = {
      host: request.host,
      project: resolution.project,
      conversation: resolution.conversation ?? file,
      session: transcript.facts.engine === "codex"
        ? codexSessionKind(transcript.facts.sessionMeta)
        : claudeSessionKind(transcript.facts.entrypoint, resolution.registered),
      launch: resolution.launch,
      ...(resolution.deliveryOrigin ? { deliveryOrigin: resolution.deliveryOrigin } : {}),
    };
    let prompted = false;
    for (const rec of transcript.records.sort((a, b) => a.at - b.at)) {
      const verdict = classifyUserRecord(rec, context, !prompted);
      if (verdict.human || !PRELUDE.has(verdict.reason)) prompted = true;
      if (rec.at < request.from || rec.at > until) continue;
      seen += 1;
      if (verdict.human) candidates.push(candidateFor(rec, context, verdict));
      else excluded[verdict.reason] = (excluded[verdict.reason] ?? 0) + 1;
    }
  }
  const inputs = dedupeCandidates(candidates);
  if (candidates.length > inputs.length) excluded.duplicate = candidates.length - inputs.length;
  return {
    manifest: { host: request.host, coveredFrom: request.from, coveredUntil: until, exportedAt: request.now, records: seen, excluded },
    inputs,
  };
}
